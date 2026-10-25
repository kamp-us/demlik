use super::{
    queue::{Action, Payload, seed, string, text},
    wire::{Number, data, normalized, snapshot},
};
use demlik_tea::{
    PlainData,
    storage::{MemoryStore, Migrated, RestoreCause, Store, memory_store, refuse},
    work_queue::*,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    fmt,
    rc::Rc,
};

#[derive(Debug, Clone)]
struct Fault(PlainData);
impl fmt::Display for Fault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(string(&self.0).as_utf8().unwrap_or("unpaired UTF-16 cause"))
    }
}
impl std::error::Error for Fault {}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    seed_raw: Option<String>,
    actions: Vec<Action>,
    migrate: Option<String>,
    reason: Option<String>,
    fault: Option<Value>,
    fail_load_at: Option<usize>,
    fail_save_at: Option<usize>,
}
struct TraceStore {
    memory: MemoryStore<Queue<Payload>>,
    events: RefCell<Vec<Value>>,
    loads: Cell<usize>,
    saves: Cell<usize>,
    migrate: String,
    reason: String,
    fault: Fault,
    fail_load_at: Option<usize>,
    fail_save_at: Option<usize>,
}
impl Store<Queue<Payload>> for TraceStore {
    type Raw = Option<Queue<Payload>>;
    type Error = Fault;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        self.loads.set(self.loads.get() + 1);
        self.events.borrow_mut().push(json!({"kind":"load"}));
        if Some(self.loads.get()) == self.fail_load_at {
            return Err(self.fault.clone());
        }
        self.memory
            .load()
            .await
            .map_err(|e| Fault(PlainData::String(e.to_string().into())))
    }
    async fn save(&self, state: &Queue<Payload>) -> Result<(), Self::Error> {
        self.saves.set(self.saves.get() + 1);
        self.events
            .borrow_mut()
            .push(json!({"kind":"save","state":snapshot(state)}));
        if Some(self.saves.get()) == self.fail_save_at {
            return Err(self.fault.clone());
        }
        self.memory
            .save(state)
            .await
            .map_err(|e| Fault(PlainData::String(e.to_string().into())))
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<Queue<Payload>> {
        self.events.borrow_mut().push(json!({"kind":"migrate"}));
        match self.migrate.as_str() {
            "refuse" => Migrated::Refused(refuse(&self.reason)),
            "fresh" => Migrated::Fresh,
            "throw" => std::panic::panic_any(
                Box::new(self.fault.clone()) as Box<dyn std::error::Error + Send>
            ),
            _ => self.memory.migrate(raw),
        }
    }
}
fn error(error: QueueError<Fault>) -> Value {
    match error {
        QueueError::Restore(error) => {
            let mut value = json!({"kind":"restore","name":error.name(),"tag":error.tag(),"reason":error.reason});
            let cause = match error.cause {
                None => None,
                Some(RestoreCause::Load(fault)) => Some(fault.0),
                Some(RestoreCause::Panic(cause)) => cause.with_payload(|payload| {
                    payload
                        .downcast_ref::<Box<dyn std::error::Error + Send>>()
                        .and_then(|cause| cause.downcast_ref::<Fault>())
                        .map(|fault| fault.0.clone())
                }),
            };
            if let Some(cause) = cause {
                value["cause"] = normalized(&cause);
            }
            value
        }
        QueueError::Save(fault) => json!({"kind":"save","cause":normalized(&fault.0)}),
        QueueError::SavePanic(cause) | QueueError::SourcePanic(cause) => {
            json!({"kind":"native_panic","summary":cause.summary})
        }
    }
}
pub async fn execute(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input: Input = serde_json::from_value(input).map_err(|e| e.to_string())?;
    let initial = input
        .seed_raw
        .as_deref()
        .map(|raw| seed(Some(raw)))
        .transpose()?;
    let store = TraceStore {
        memory: memory_store(initial),
        events: RefCell::new(Vec::new()),
        loads: Cell::new(0),
        saves: Cell::new(0),
        migrate: input.migrate.unwrap_or_else(|| "identity".into()),
        reason: input.reason.unwrap_or_else(|| "unsupported queue".into()),
        fault: Fault(input.fault.as_ref().map_or(PlainData::Undefined, data)),
        fail_load_at: input.fail_load_at,
        fail_save_at: input.fail_save_at,
    };
    let clock_calls = Cell::new(0);
    let id_calls = Cell::new(0);
    let now = Cell::new(0.0);
    let id = RefCell::new(demlik_tea::data::JsText::from("generated"));
    let queue = observe!(
        calls,
        demlik_tea::work_queue::QueueClient::with_sources,
        store,
        || {
            clock_calls.set(clock_calls.get() + 1);
            now.get()
        },
        || {
            id_calls.set(id_calls.get() + 1);
            id.borrow().clone()
        }
    );
    let mut observations = Vec::new();
    for action in input.actions {
        let mut result = json!({"$undefined":true});
        let (op, status) = match action {
            Action::Enqueue {
                input,
                id: new_id,
                at,
            } => {
                now.set(at.map_or(0.0, Number::value));
                *id.borrow_mut() = text(&new_id);
                let value = observe_async!(
                    calls,
                    demlik_tea::work_queue::QueueClient::enqueue,
                    &queue,
                    Rc::new(RefCell::new(data(&input)))
                );
                let status = value.map(|value| {
                    result = snapshot(&value);
                });
                ("enqueue", status)
            }
            Action::MutateList { input, id, at } => {
                let list = observe_async!(calls, demlik_tea::work_queue::QueueClient::list, &queue);
                let status = list.map(|list| {
                    let item = observe!(
                        calls,
                        demlik_tea::work_queue::QueueItem::new,
                        Rc::new(RefCell::new(data(&input))),
                        at.map_or(0.0, Number::value),
                        text(&id)
                    );
                    list.items_mut().push(Rc::new(item));
                });
                ("mutateList", status)
            }
            Action::MutateInput { index, key, value } => {
                let list = observe_async!(calls, demlik_tea::work_queue::QueueClient::list, &queue);
                let status = list.map(|list| {
                    if let Some(item) = list.get(index)
                        && let PlainData::Object(fields) = &mut *item.input.borrow_mut()
                    {
                        fields.insert(text(&key), data(&value));
                    }
                });
                ("mutateInput", status)
            }
            Action::Claim { at } => {
                now.set(at.map_or(0.0, Number::value));
                let value = observe_async!(
                    calls,
                    demlik_tea::work_queue::QueueClient::claim_next,
                    &queue
                );
                let status = value.map(|value| {
                    result = snapshot(&value);
                });
                ("claim", status)
            }
            Action::Done { id } => (
                "done",
                observe_async!(
                    calls,
                    demlik_tea::work_queue::QueueClient::mark_done,
                    &queue,
                    text(&id)
                ),
            ),
            Action::Remove { id } => (
                "remove",
                observe_async!(
                    calls,
                    demlik_tea::work_queue::QueueClient::remove_item,
                    &queue,
                    text(&id)
                ),
            ),
            Action::Cancel { id, at } => {
                now.set(at.map_or(0.0, Number::value));
                (
                    "cancel",
                    observe_async!(
                        calls,
                        demlik_tea::work_queue::QueueClient::mark_cancelled,
                        &queue,
                        text(&id)
                    ),
                )
            }
            Action::Fail { id, error, at } => {
                now.set(at.map_or(0.0, Number::value));
                (
                    "fail",
                    observe_async!(
                        calls,
                        demlik_tea::work_queue::QueueClient::mark_failed,
                        &queue,
                        text(&id),
                        text(&error)
                    ),
                )
            }
            Action::Retry { id } => (
                "retry",
                observe_async!(
                    calls,
                    demlik_tea::work_queue::QueueClient::retry_item,
                    &queue,
                    text(&id)
                ),
            ),
            Action::Bind { id, value } => (
                "bind",
                observe_async!(
                    calls,
                    demlik_tea::work_queue::QueueClient::bind_output,
                    &queue,
                    text(&id),
                    text(&value)
                ),
            ),
            Action::Reset => (
                "reset",
                observe_async!(
                    calls,
                    demlik_tea::work_queue::QueueClient::reset_running_to_pending,
                    &queue
                ),
            ),
            Action::List => {
                let value =
                    observe_async!(calls, demlik_tea::work_queue::QueueClient::list, &queue);
                let status = value.map(|value| {
                    result = snapshot(&value);
                });
                ("list", status)
            }
            _ => return Err("action is not a stored queue verb".into()),
        };
        let cell = queue
            .store()
            .memory
            .load()
            .await
            .map_err(|e| e.to_string())?;
        let mut observation = json!({"op":op,"cell":snapshot(&cell),"clockCalls":clock_calls.get(),"idCalls":id_calls.get()});
        match status {
            Ok(()) => {
                observation["result"] = result;
            }
            Err(cause) => {
                observation["error"] = error(cause);
            }
        }
        observations.push(observation);
    }
    Ok(
        json!({"observations":observations,"events":queue.store().events.borrow().clone(),"loads":queue.store().loads.get(),"saves":queue.store().saves.get()}),
    )
}
pub async fn defaults(calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let queue = observe!(
        calls,
        demlik_tea::work_queue::create_queue,
        memory_store(None)
    );
    let first = observe_async!(
        calls,
        demlik_tea::work_queue::QueueClient::enqueue,
        &queue,
        Rc::new("first")
    )
    .map_err(|e| e.to_string())?;
    let second = observe_async!(
        calls,
        demlik_tea::work_queue::QueueClient::enqueue,
        &queue,
        Rc::new("second")
    )
    .map_err(|e| e.to_string())?;
    let list = observe_async!(calls, demlik_tea::work_queue::QueueClient::list, &queue)
        .map_err(|e| e.to_string())?;
    let uuid = |item: &QueueItem<&str>| {
        let Some(id) = item.id.as_utf8() else {
            return false;
        };
        id.len() == 36
            && [8, 13, 18, 23].iter().all(|i| id.as_bytes()[*i] == b'-')
            && id.as_bytes()[14] == b'4'
            && matches!(id.as_bytes()[19], b'8' | b'9' | b'a' | b'b')
            && id.bytes().all(|c| c == b'-' || c.is_ascii_hexdigit())
    };
    let integer = |item: &QueueItem<&str>| {
        item.enqueued_at
            .number()
            .is_some_and(|at| at.fract() == 0.0 && at > 1e12)
    };
    Ok(
        json!({"unique":first.id!=second.id,"uuidV4":[uuid(&first),uuid(&second)],"integerEpoch":[integer(&first),integer(&second)],"input":list.iter().map(|item|*item.input).collect::<Vec<_>>(),"statuses":list.iter().map(|item|item.status).collect::<Vec<_>>(),"sharedItem":Rc::ptr_eq(&list.get(0).unwrap(),&first)}),
    )
}
