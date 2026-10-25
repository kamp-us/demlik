//! Pending effects are reconstructed from the same owed/confirmed event log.

mod wire;
pub use crate::work_queue::QueueTime as DeliveryId;
use crate::{Tagged, work_queue::QueueField};
use std::{cell::RefCell, ops::Deref, rc::Rc};

pub struct EffectOwedFields<E> {
    pub id: DeliveryId,
    pub effect: Rc<E>,
}
pub struct EffectOwed<E> {
    fields: EffectOwedFields<E>,
    effect_present: bool,
}
impl<E> EffectOwed<E> {
    pub fn new(id: DeliveryId, effect: Rc<E>) -> Self {
        Self {
            fields: EffectOwedFields { id, effect },
            effect_present: true,
        }
    }
    pub fn effect_present(&self) -> bool {
        self.effect_present
    }
}
impl<E> Deref for EffectOwed<E> {
    type Target = EffectOwedFields<E>;
    fn deref(&self) -> &Self::Target {
        &self.fields
    }
}
#[derive(Clone, Copy, Debug)]
pub struct EffectConfirmed {
    pub id: DeliveryId,
}
pub enum EffectLedgerEvent<E> {
    Owed(EffectOwed<E>),
    Confirmed(EffectConfirmed),
}
impl<E> Tagged for EffectLedgerEvent<E> {
    fn tag(&self) -> &str {
        match self {
            Self::Owed(_) => "effect_owed",
            Self::Confirmed(_) => "effect_confirmed",
        }
    }
}
impl<E> AsRef<Self> for EffectLedgerEvent<E> {
    fn as_ref(&self) -> &Self {
        self
    }
}
pub struct OwedEffect<E> {
    pub id: DeliveryId,
    pub effect: Rc<E>,
}
impl<E> Clone for OwedEffect<E> {
    fn clone(&self) -> Self {
        Self {
            id: self.id,
            effect: Rc::clone(&self.effect),
        }
    }
}
pub struct PendingEffectsLedger<E> {
    entries: Vec<OwedEffect<E>>,
}
fn same_key(left: DeliveryId, right: DeliveryId) -> bool {
    match (left.number(), right.number()) {
        (None, None) => true,
        (Some(left), Some(right)) => left == right || (left.is_nan() && right.is_nan()),
        _ => false,
    }
}
fn map_key(id: DeliveryId) -> DeliveryId {
    if id.number() == Some(0.0) {
        0.0.into()
    } else {
        id
    }
}
impl<E> Clone for PendingEffectsLedger<E> {
    fn clone(&self) -> Self {
        Self {
            entries: self.entries.clone(),
        }
    }
}
impl<E> PendingEffectsLedger<E> {
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub fn get(&self, id: DeliveryId) -> Option<&Rc<E>> {
        self.entries
            .iter()
            .find(|entry| same_key(entry.id, id))
            .map(|entry| &entry.effect)
    }
}
pub fn empty_ledger<E>() -> Rc<PendingEffectsLedger<E>> {
    Rc::new(PendingEffectsLedger { entries: vec![] })
}
pub fn apply_effect_event<E>(
    ledger: &PendingEffectsLedger<E>,
    event: &EffectLedgerEvent<E>,
) -> Rc<PendingEffectsLedger<E>> {
    let mut next = ledger.clone();
    match event {
        EffectLedgerEvent::Owed(event) => {
            if let Some(entry) = next
                .entries
                .iter_mut()
                .find(|entry| same_key(entry.id, event.id))
            {
                entry.effect = Rc::clone(&event.effect)
            } else {
                next.entries.push(OwedEffect {
                    id: map_key(event.id),
                    effect: Rc::clone(&event.effect),
                });
            }
        }
        EffectLedgerEvent::Confirmed(event) => {
            next.entries.retain(|entry| !same_key(entry.id, event.id))
        }
    }
    Rc::new(next)
}
pub fn fold_ledger<E, I>(events: I) -> Rc<PendingEffectsLedger<E>>
where
    I: IntoIterator,
    I::Item: AsRef<EffectLedgerEvent<E>>,
{
    let mut ledger = empty_ledger();
    for event in events {
        ledger = apply_effect_event(&ledger, event.as_ref());
    }
    ledger
}
pub fn surviving_effects<E>(ledger: &PendingEffectsLedger<E>) -> Vec<OwedEffect<E>> {
    ledger.entries.clone()
}
pub fn is_owed<E>(ledger: &PendingEffectsLedger<E>, id: DeliveryId) -> bool {
    ledger.get(id).is_some()
}
pub struct LedgerRestore<E> {
    pub events: Vec<Rc<EffectLedgerEvent<E>>>,
    pub last_id: QueueField<DeliveryId>,
}
impl<E> Default for LedgerRestore<E> {
    fn default() -> Self {
        Self {
            events: vec![],
            last_id: QueueField::Absent,
        }
    }
}
impl<E> LedgerRestore<E> {
    pub fn from_events(events: impl IntoIterator<Item = Rc<EffectLedgerEvent<E>>>) -> Self {
        Self {
            events: events.into_iter().collect(),
            last_id: QueueField::Absent,
        }
    }
}
pub struct OweResult<E> {
    pub id: DeliveryId,
    pub event: Rc<EffectLedgerEvent<E>>,
}
pub struct ConfirmResult<E> {
    pub confirmed: bool,
    pub event: Rc<EffectLedgerEvent<E>>,
}
struct RecorderState<E> {
    counter: f64,
    ledger: Rc<PendingEffectsLedger<E>>,
}
pub struct PendingEffectsRecorder<E>(RefCell<RecorderState<E>>);
pub fn pending_effects_ledger<E>(restore: LedgerRestore<E>) -> PendingEffectsRecorder<E> {
    let ledger = fold_ledger(&restore.events);
    let mut counter = restore
        .last_id
        .value()
        .and_then(|id| id.number())
        .unwrap_or(0.0);
    if !matches!(restore.last_id, QueueField::Value(_)) {
        for event in &restore.events {
            let id = match event.as_ref() {
                EffectLedgerEvent::Owed(event) => event.id,
                EffectLedgerEvent::Confirmed(event) => event.id,
            };
            if let Some(id) = id.number()
                && id > counter
            {
                counter = id;
            }
        }
    }
    PendingEffectsRecorder(RefCell::new(RecorderState { counter, ledger }))
}
impl<E> PendingEffectsRecorder<E> {
    pub fn owe(&self, effect: Rc<E>) -> OweResult<E> {
        let mut state = self.0.borrow_mut();
        state.counter += 1.0;
        let id = state.counter.into();
        let event = Rc::new(EffectLedgerEvent::Owed(EffectOwed::new(id, effect)));
        state.ledger = apply_effect_event(&state.ledger, event.as_ref());
        OweResult { id, event }
    }
    pub fn confirm(&self, id: DeliveryId) -> ConfirmResult<E> {
        let mut state = self.0.borrow_mut();
        let confirmed = is_owed(&state.ledger, id);
        let event = Rc::new(EffectLedgerEvent::Confirmed(EffectConfirmed { id }));
        state.ledger = apply_effect_event(&state.ledger, event.as_ref());
        ConfirmResult { confirmed, event }
    }
    pub fn surviving(&self) -> Vec<OwedEffect<E>> {
        surviving_effects(&self.0.borrow().ledger)
    }
    pub fn ledger(&self) -> Rc<PendingEffectsLedger<E>> {
        Rc::clone(&self.0.borrow().ledger)
    }
    pub fn last_id(&self) -> f64 {
        self.0.borrow().counter
    }
}
