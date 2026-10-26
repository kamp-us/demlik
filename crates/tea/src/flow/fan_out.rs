//! Pure scatter/gather over the shared queue ledger. `Rc` preserves payload and
//! no-op slice identity without requiring models, results, or failures to clone.

use crate::ports::Port;
use crate::{
    PlainData, Step, Tagged,
    data::JsText,
    work_queue::{Queue, QueueItemStatus, claim_next_op, enqueue_op},
};
use serde::{Deserialize, Serialize};
use std::{marker::PhantomData, rc::Rc};

#[derive(Debug, Serialize)]
pub struct FanOutDone<I, R> {
    pub item: Rc<I>,
    pub result: Rc<R>,
}
#[derive(Debug, Serialize)]
pub struct FanOutFailed<I, E> {
    pub item: Rc<I>,
    pub error: Rc<E>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(
    rename_all = "camelCase",
    bound(
        deserialize = "I: serde::de::DeserializeOwned,R: serde::de::DeserializeOwned,E: serde::de::DeserializeOwned"
    )
)]
pub struct FanOutState<I, R, E = PlainData> {
    pub pending: Vec<Rc<I>>,
    pub running: Vec<Rc<I>>,
    pub done: Vec<Rc<FanOutDone<I, R>>>,
    pub failed: Vec<Rc<FanOutFailed<I, E>>>,
    pub items: Queue<I>,
    pub wave_done_from: f64,
    pub wave_failed_from: f64,
    pub joined: bool,
}
impl<I, R, E> Clone for FanOutState<I, R, E> {
    fn clone(&self) -> Self {
        Self {
            pending: self.pending.clone(),
            running: self.running.clone(),
            done: self.done.clone(),
            failed: self.failed.clone(),
            items: self.items.clone(),
            wave_done_from: self.wave_done_from,
            wave_failed_from: self.wave_failed_from,
            joined: self.joined,
        }
    }
}
impl<I, R, E> Default for FanOutState<I, R, E> {
    fn default() -> Self {
        Self {
            pending: vec![],
            running: vec![],
            done: vec![],
            failed: vec![],
            items: Queue::new(),
            wave_done_from: 0.0,
            wave_failed_from: 0.0,
            joined: false,
        }
    }
}
pub fn init_fan_out<I, R>() -> Rc<FanOutState<I, R>> {
    Rc::new(FanOutState::default())
}
pub fn is_complete<I, R, E>(state: &FanOutState<I, R, E>) -> bool {
    !state.items.is_empty() && state.pending.is_empty() && state.running.is_empty()
}
type IdOf<'a, I> = Box<dyn Fn(&I) -> JsText + 'a>;
type Launch<'a, I, C> = Box<dyn Fn(&Rc<I>) -> C + 'a>;
pub struct FanOutConfig<'a, I, C> {
    pub concurrency: f64,
    id_of: IdOf<'a, I>,
    of: Launch<'a, I, C>,
}
impl<'a, I, C> FanOutConfig<'a, I, C> {
    pub fn new(
        concurrency: f64,
        id_of: impl Fn(&I) -> JsText + 'a,
        of: impl Fn(&Rc<I>) -> C + 'a,
    ) -> Self {
        Self {
            concurrency,
            id_of: Box::new(id_of),
            of: Box::new(of),
        }
    }
}
type Join<'a, R, C> = Box<dyn Fn(&[Rc<R>]) -> C + 'a>;
pub struct FanOut<'a, I, R, C, E = PlainData> {
    config: FanOutConfig<'a, I, C>,
    join: Option<Join<'a, R, C>>,
    types: PhantomData<fn() -> E>,
}
struct SettledItem<I, R, E> {
    state: FanOutState<I, R, E>,
    input: Rc<I>,
}
pub(crate) fn slice_start(index: f64, len: usize) -> usize {
    if index.is_nan() {
        0
    } else if index.trunc() < 0.0 {
        (len as f64 + index.trunc()).max(0.0) as usize
    } else {
        index.min(len as f64) as usize
    }
}
pub fn create_fan_out<I, R, C: Tagged>(config: FanOutConfig<'_, I, C>) -> FanOut<'_, I, R, C> {
    FanOut::new(config)
}
impl<'a, I, R, C: Tagged, E> FanOut<'a, I, R, C, E> {
    pub fn new(config: FanOutConfig<'a, I, C>) -> Self {
        Self {
            config,
            join: None,
            types: PhantomData,
        }
    }
    pub fn with_join(mut self, join: impl Fn(&[Rc<R>]) -> C + 'a) -> Self {
        self.join = Some(Box::new(join));
        self
    }
    pub fn init(&self) -> Rc<FanOutState<I, R, E>> {
        Rc::new(FanOutState::default())
    }
    pub fn is_complete(&self, state: &FanOutState<I, R, E>) -> bool {
        is_complete(state)
    }
    pub fn scatter(
        &self,
        state: &Rc<FanOutState<I, R, E>>,
        inputs: impl IntoIterator<Item = Rc<I>>,
    ) -> Step<Rc<FanOutState<I, R, E>>, C> {
        let mut next = state.as_ref().clone();
        for input in inputs {
            next.items = enqueue_op(
                &next.items,
                Rc::clone(&input),
                0.0,
                (self.config.id_of)(&input),
            )
            .next;
            next.pending.push(input);
        }
        if state.pending.is_empty() && state.running.is_empty() {
            next.wave_done_from = state.done.len() as f64;
            next.wave_failed_from = state.failed.len() as f64;
            next.joined = false;
        }
        self.launch(Rc::new(next))
    }
    fn launch(&self, state: Rc<FanOutState<I, R, E>>) -> Step<Rc<FanOutState<I, R, E>>, C> {
        let budget = if self.config.concurrency < 1.0 {
            1.0
        } else {
            self.config.concurrency.floor()
        };
        let slots = budget - state.running.len() as f64;
        if slots <= 0.0 || state.pending.is_empty() {
            return Step::new(state, vec![]);
        }
        let count = if slots.is_nan() {
            0
        } else {
            slots.min(state.pending.len() as f64) as usize
        };
        let mut next = state.as_ref().clone();
        let launched = next.pending.drain(..count).collect::<Vec<_>>();
        for _ in &launched {
            if let Some(claimed) = claim_next_op(&next.items, 0.0) {
                next.items = claimed.next;
            } else {
                break;
            }
        }
        next.running.extend(launched.iter().cloned());
        let commands = launched
            .iter()
            .map(|input| (self.config.of)(input))
            .collect();
        Step::new(Rc::new(next), commands)
    }

    fn settle_one(
        &self,
        state: &Rc<FanOutState<I, R, E>>,
        id: &JsText,
        status: QueueItemStatus,
    ) -> Option<SettledItem<I, R, E>> {
        let index = state
            .running
            .iter()
            .position(|input| (self.config.id_of)(input) == *id)?;
        let mut next = state.as_ref().clone();
        let input = next.running.remove(index);
        let mut ledger = next.items.to_vec();
        if let Some(index) = ledger
            .iter()
            .position(|item| item.id == *id && item.status == QueueItemStatus::Running)
        {
            // Duplicate ids settle one running record, including after an older
            // record with the same id has already completed.
            ledger[index] = Rc::new(ledger[index].with_status(status));
            next.items = Queue::from_items(ledger);
        }
        Some(SettledItem { state: next, input })
    }
    pub fn item_ok(
        &self,
        state: &Rc<FanOutState<I, R, E>>,
        id: &JsText,
        result: Rc<R>,
    ) -> Step<Rc<FanOutState<I, R, E>>, C> {
        let Some(mut settled) = self.settle_one(state, id, QueueItemStatus::Done) else {
            return Step::new(Rc::clone(state), vec![]);
        };
        settled.state.done.push(Rc::new(FanOutDone {
            item: settled.input,
            result,
        }));
        self.finish_or_launch(Rc::new(settled.state))
    }
    pub fn item_err(
        &self,
        state: &Rc<FanOutState<I, R, E>>,
        id: &JsText,
        error: Rc<E>,
    ) -> Step<Rc<FanOutState<I, R, E>>, C> {
        let Some(mut settled) = self.settle_one(state, id, QueueItemStatus::Failed) else {
            return Step::new(Rc::clone(state), vec![]);
        };
        settled.state.failed.push(Rc::new(FanOutFailed {
            item: settled.input,
            error,
        }));
        self.finish_or_launch(Rc::new(settled.state))
    }
    fn finish_or_launch(
        &self,
        state: Rc<FanOutState<I, R, E>>,
    ) -> Step<Rc<FanOutState<I, R, E>>, C> {
        let mut launched = self.launch(state);
        if let Some(join) = &self.join
            && !launched.state.joined
            && is_complete(&launched.state)
        {
            let results = launched.state.done
                [slice_start(launched.state.wave_done_from, launched.state.done.len())..]
                .iter()
                .map(|done| Rc::clone(&done.result))
                .collect::<Vec<_>>();
            let mut next = launched.state.as_ref().clone();
            next.joined = true;
            launched.state = Rc::new(next);
            launched.commands.push(join(&results));
        }
        launched
    }
}

pub struct FanOutPorts<R> {
    pub complete: Port<Vec<Rc<R>>>,
}
pub struct FanOutCompletion<R> {
    ports: FanOutPorts<R>,
}
impl<R> FanOutCompletion<R> {
    pub fn emit_on_complete<I, E>(
        &self,
        mut emit: impl FnMut(&Port<Vec<Rc<R>>>, Vec<Rc<R>>),
        state: &FanOutState<I, R, E>,
    ) {
        if !is_complete(state) {
            return;
        }
        let results = state.done[slice_start(state.wave_done_from, state.done.len())..]
            .iter()
            .map(|done| Rc::clone(&done.result))
            .collect();
        emit(&self.ports.complete, results);
    }
}
impl<I, R, C, E> FanOut<'_, I, R, C, E> {
    pub fn completion(&self, ports: FanOutPorts<R>) -> FanOutCompletion<R> {
        FanOutCompletion { ports }
    }
}

fn restored_payload<T: serde::de::DeserializeOwned, E: serde::de::Error>(
    field: crate::work_queue::QueueField<Box<serde_json::value::RawValue>>,
    name: &'static str,
) -> Result<Rc<T>, E> {
    match field {
        crate::work_queue::QueueField::Value(raw) => serde_json::from_str(raw.get())
            .map(Rc::new)
            .map_err(E::custom),
        _ => crate::data::decode_missing(name).map(Rc::new),
    }
}
impl<'de, I: serde::de::DeserializeOwned, R: serde::de::DeserializeOwned> Deserialize<'de>
    for FanOutDone<I, R>
{
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Fields {
            #[serde(default)]
            item: crate::work_queue::QueueField<Box<serde_json::value::RawValue>>,
            #[serde(default)]
            result: crate::work_queue::QueueField<Box<serde_json::value::RawValue>>,
        }
        let f = Fields::deserialize(deserializer)?;
        Ok(Self {
            item: restored_payload(f.item, "item")?,
            result: restored_payload(f.result, "result")?,
        })
    }
}
impl<'de, I: serde::de::DeserializeOwned, E: serde::de::DeserializeOwned> Deserialize<'de>
    for FanOutFailed<I, E>
{
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Fields {
            #[serde(default)]
            item: crate::work_queue::QueueField<Box<serde_json::value::RawValue>>,
            #[serde(default)]
            error: crate::work_queue::QueueField<Box<serde_json::value::RawValue>>,
        }
        let f = Fields::deserialize(deserializer)?;
        Ok(Self {
            item: restored_payload(f.item, "item")?,
            error: restored_payload(f.error, "error")?,
        })
    }
}
