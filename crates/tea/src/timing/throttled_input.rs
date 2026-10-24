use crate::{
    PlainData, Step, Tagged,
    data::{JsText, plain_data},
    js_record::{JsAccessError, JsRead},
    resilience::{
        cache::{self, TtlCache},
        deadline::{Deadline, deadline_sub},
    },
};
use serde::{Deserialize, Serialize};
use std::rc::Rc;

pub use super::{Debounced, Throttled, debounce, throttle};
pub use crate::resilience::deadline::subscribe_deadline as subscribe_throttled_input;
pub use crate::resilience::deadline::{
    DeadlineExceeded as ThrottledInputSettled, deadline_exceeded as throttled_input_settled,
};
pub type ThrottledInputSub = Deadline;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct InputInstant(Option<f64>);
impl InputInstant {
    pub fn value(self) -> f64 {
        self.0.unwrap_or(0.0)
    }
}
impl From<f64> for InputInstant {
    fn from(value: f64) -> Self {
        Self(Some(value))
    }
}
fn present() -> bool {
    true
}
#[derive(Debug, Deserialize)]
pub struct PendingInput<V> {
    pub value: Rc<V>,
    pub at: InputInstant,
    #[serde(skip, default = "present")]
    value_present: bool,
}
impl<V> PendingInput<V> {
    pub fn new(value: V, at: f64) -> Self {
        Self {
            value: Rc::new(value),
            at: at.into(),
            value_present: true,
        }
    }
}
impl<V: Serialize> Serialize for PendingInput<V> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(None)?;
        if self.value_present {
            map.serialize_entry("value", &self.value)?;
        }
        map.serialize_entry("at", &self.at)?;
        map.end()
    }
}
impl<V> Clone for PendingInput<V> {
    fn clone(&self) -> Self {
        Self {
            value: Rc::clone(&self.value),
            at: self.at,
            value_present: self.value_present,
        }
    }
}
pub type InputCache<V> = Rc<TtlCache<Rc<V>>>;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputState<V> {
    pub last_at: Option<f64>,
    pub pending: Option<PendingInput<V>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache: Option<InputCache<V>>,
}
impl<V> Clone for InputState<V> {
    fn clone(&self) -> Self {
        Self {
            last_at: self.last_at,
            pending: self.pending.clone(),
            cache: self.cache.clone(),
        }
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(transparent)]
pub struct ThrottledInput<V>(Rc<InputState<V>>);
impl<V> Clone for ThrottledInput<V> {
    fn clone(&self) -> Self {
        Self(Rc::clone(&self.0))
    }
}
impl<V> ThrottledInput<V> {
    pub fn from_state(state: InputState<V>) -> Self {
        Self(Rc::new(state))
    }
    pub fn state(&self) -> &InputState<V> {
        &self.0
    }
    pub fn last_at(&self) -> Option<f64> {
        self.0.last_at
    }
    pub fn pending(&self) -> Option<&PendingInput<V>> {
        self.0.pending.as_ref()
    }
    pub fn ptr_eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
    /// Identity-style restore keeps JSON's numeric/null changes and raw cache
    /// entries. The caller parses input payloads, including a missing `value`
    /// represented by PlainData::Undefined, into its own precise `V`.
    pub fn restore_data<E>(
        raw: PlainData,
        parse_value: impl Fn(PlainData) -> Result<V, E>,
    ) -> Result<Self, InputRestoreError<E>> {
        use InputRestoreError::Field;
        let PlainData::Object(mut state) = raw else {
            return Err(Field("state"));
        };
        let last_at = match state.shift_remove("lastAt") {
            Some(PlainData::Null) => None,
            Some(PlainData::Number(value)) => Some(value),
            _ => return Err(Field("lastAt")),
        };
        let pending = match state.shift_remove("pending") {
            Some(PlainData::Null) => None,
            Some(PlainData::Object(mut pending)) => {
                let at = match pending.shift_remove("at") {
                    Some(PlainData::Null) => InputInstant(None),
                    Some(PlainData::Number(at)) => at.into(),
                    _ => return Err(Field("pending.at")),
                };
                let value_present = pending.contains_key("value");
                let value = parse_value(
                    pending
                        .shift_remove("value")
                        .unwrap_or(PlainData::Undefined),
                )
                .map_err(InputRestoreError::Value)?;
                Some(PendingInput {
                    value: Rc::new(value),
                    at,
                    value_present,
                })
            }
            _ => return Err(Field("pending")),
        };
        let cache = match state.shift_remove("cache") {
            None => None,
            Some(PlainData::Object(mut cache)) => {
                let Some(PlainData::Object(entries)) = cache.shift_remove("entries") else {
                    return Err(Field("cache.entries"));
                };
                Some(Rc::new(TtlCache {
                    entries: crate::js_record::JsRecord::from_data(entries),
                }))
            }
            _ => return Err(Field("cache")),
        };
        Ok(Self::from_state(InputState {
            last_at,
            pending,
            cache,
        }))
    }
}
#[derive(Debug)]
pub enum InputRestoreError<E> {
    Field(&'static str),
    Value(E),
}
impl<E: std::fmt::Display> std::fmt::Display for InputRestoreError<E> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Field(field) => write!(f, "invalid throttled-input field: {field}"),
            Self::Value(error) => write!(f, "invalid throttled-input value: {error}"),
        }
    }
}
impl<E: std::fmt::Debug + std::fmt::Display> std::error::Error for InputRestoreError<E> {}
pub fn init_throttled_input<V>() -> ThrottledInput<V> {
    ThrottledInput::from_state(InputState {
        last_at: None,
        pending: None,
        cache: None,
    })
}

mod sealed {
    pub trait Sealed {}
}
pub struct NoCache;
pub struct WithCache<K> {
    pub ttl_ms: f64,
    pub key: K,
}
impl sealed::Sealed for NoCache {}
impl<K> sealed::Sealed for WithCache<K> {}
pub trait CachePolicy<V>: sealed::Sealed {
    fn enabled(&self) -> bool;
    fn hit(&self, cache: Option<&InputCache<V>>, value: &V, at: f64)
    -> Result<bool, JsAccessError>;
    fn record(&self, cache: Option<&InputCache<V>>, value: Rc<V>, at: f64)
    -> Option<InputCache<V>>;
}
impl<V> CachePolicy<V> for NoCache {
    fn enabled(&self) -> bool {
        false
    }
    fn hit(&self, _: Option<&InputCache<V>>, _: &V, _: f64) -> Result<bool, JsAccessError> {
        Ok(false)
    }
    fn record(&self, cache: Option<&InputCache<V>>, _: Rc<V>, _: f64) -> Option<InputCache<V>> {
        cache.cloned()
    }
}
impl<V: Serialize, K: Fn(&V) -> R, R: Into<JsText>> CachePolicy<V> for WithCache<K> {
    fn enabled(&self) -> bool {
        true
    }
    fn hit(
        &self,
        cache: Option<&InputCache<V>>,
        value: &V,
        at: f64,
    ) -> Result<bool, JsAccessError> {
        let Some(cache) = cache else { return Ok(false) };
        match cache::get(cache, (self.key)(value).into(), at)? {
            None => Ok(false),
            Some(JsRead::Projected(_)) => Ok(true),
            Some(JsRead::Stored(value)) => plain_data(value)
                .map(|data| !matches!(data, PlainData::Undefined))
                .map_err(|error| JsAccessError {
                    name: "TypeError",
                    message: error.to_string(),
                }),
        }
    }
    fn record(
        &self,
        cache: Option<&InputCache<V>>,
        value: Rc<V>,
        at: f64,
    ) -> Option<InputCache<V>> {
        cache.map(|cache| {
            Rc::new(cache::set(
                cache,
                (self.key)(&value).into(),
                value,
                at,
                self.ttl_ms,
            ))
        })
    }
}
pub struct ThrottledInputConfig<F, P = NoCache> {
    pub throttle_ms: Option<f64>,
    pub debounce_ms: Option<f64>,
    pub emit: F,
    pub dedupe: P,
}
impl<F> ThrottledInputConfig<F, NoCache> {
    pub fn new(emit: F) -> Self {
        Self {
            throttle_ms: None,
            debounce_ms: None,
            emit,
            dedupe: NoCache,
        }
    }
    /// Dedupe requires a key; there is no implicit string conversion.
    /// ```compile_fail,E0061
    /// use demlik_tea::timing::throttled_input::ThrottledInputConfig;
    /// let config=ThrottledInputConfig::new(|value:&String|value.len()).with_cache(500.0);
    /// ```
    pub fn with_cache<K>(self, ttl_ms: f64, key: K) -> ThrottledInputConfig<F, WithCache<K>> {
        ThrottledInputConfig {
            throttle_ms: self.throttle_ms,
            debounce_ms: self.debounce_ms,
            emit: self.emit,
            dedupe: WithCache { ttl_ms, key },
        }
    }
}
impl<F, P> ThrottledInputConfig<F, P> {
    pub fn throttle(mut self, ms: f64) -> Self {
        self.throttle_ms = Some(ms);
        self
    }
    pub fn debounce(mut self, ms: f64) -> Self {
        self.debounce_ms = Some(ms);
        self
    }
}
fn rate_blocked<F, P, V>(
    config: &ThrottledInputConfig<F, P>,
    state: &ThrottledInput<V>,
    at: f64,
) -> bool {
    matches!((config.throttle_ms,state.last_at()),(Some(ms),Some(last)) if at-last<ms)
}
fn commit<V, C: Tagged, F: Fn(&V) -> C, P: CachePolicy<V>>(
    config: &ThrottledInputConfig<F, P>,
    state: &ThrottledInput<V>,
    value: Rc<V>,
    at: f64,
) -> Step<ThrottledInput<V>, C> {
    let cache = config
        .dedupe
        .record(state.0.cache.as_ref(), Rc::clone(&value), at);
    let next = ThrottledInput::from_state(InputState {
        last_at: Some(at),
        pending: None,
        cache,
    });
    Step::new(next, vec![(config.emit)(&value)])
}
/// The emit hook constructs a command with an explicit tag.
/// ```compile_fail,E0277
/// use demlik_tea::timing::throttled_input::*;
/// let knob=create_throttled_input(ThrottledInputConfig::new(|value:&u32|*value));
/// let _=knob.input(&knob.init(),1,0.0);
/// ```
pub fn input<V, C: Tagged, F: Fn(&V) -> C, P: CachePolicy<V>>(
    config: &ThrottledInputConfig<F, P>,
    state: &ThrottledInput<V>,
    value: V,
    at: f64,
) -> Result<Step<ThrottledInput<V>, C>, JsAccessError> {
    if config.dedupe.hit(state.0.cache.as_ref(), &value, at)? {
        return Ok(Step::new(state.clone(), vec![]));
    }
    let blocked = rate_blocked(config, state, at);
    if config.debounce_ms.is_some() {
        let mut next = state.0.as_ref().clone();
        next.pending = Some(PendingInput::new(value, at));
        return Ok(Step::new(ThrottledInput::from_state(next), vec![]));
    }
    if blocked {
        return Ok(Step::new(state.clone(), vec![]));
    }
    Ok(commit(config, state, Rc::new(value), at))
}
pub fn on_flush<V, C: Tagged, F: Fn(&V) -> C, P: CachePolicy<V>>(
    config: &ThrottledInputConfig<F, P>,
    state: &ThrottledInput<V>,
    at: f64,
) -> Result<Step<ThrottledInput<V>, C>, JsAccessError> {
    let Some(pending) = state.pending() else {
        return Ok(Step::new(state.clone(), vec![]));
    };
    if rate_blocked(config, state, at) {
        return Ok(Step::new(state.clone(), vec![]));
    }
    Ok(commit(config, state, Rc::clone(&pending.value), at))
}
pub fn subs_for<V, F, P>(
    config: &ThrottledInputConfig<F, P>,
    state: &ThrottledInput<V>,
    id: Option<JsText>,
) -> Vec<Deadline> {
    let (Some(ms), Some(pending)) = (config.debounce_ms, state.pending()) else {
        return vec![];
    };
    let settle_at = pending.at.value() + ms;
    let rate_at = match (config.throttle_ms, state.last_at()) {
        (Some(ms), Some(last)) => last + ms,
        _ => settle_at,
    };
    vec![deadline_sub(
        id.unwrap_or_else(|| "throttled-input:settle".into()),
        crate::js_math::max(settle_at, rate_at),
    )]
}
pub struct ThrottledInputKnob<F, P = NoCache> {
    pub config: ThrottledInputConfig<F, P>,
}
pub fn create_throttled_input<F, P>(
    config: ThrottledInputConfig<F, P>,
) -> ThrottledInputKnob<F, P> {
    ThrottledInputKnob { config }
}
impl<F, P> ThrottledInputKnob<F, P> {
    pub fn init<V>(&self) -> ThrottledInput<V>
    where
        P: CachePolicy<V>,
    {
        ThrottledInput::from_state(InputState {
            last_at: None,
            pending: None,
            cache: self
                .config
                .dedupe
                .enabled()
                .then(|| Rc::new(cache::init_cache())),
        })
    }
    pub fn input<V, C: Tagged>(
        &self,
        state: &ThrottledInput<V>,
        value: V,
        at: f64,
    ) -> Result<Step<ThrottledInput<V>, C>, JsAccessError>
    where
        F: Fn(&V) -> C,
        P: CachePolicy<V>,
    {
        input(&self.config, state, value, at)
    }
    pub fn on_flush<V, C: Tagged>(
        &self,
        state: &ThrottledInput<V>,
        at: f64,
    ) -> Result<Step<ThrottledInput<V>, C>, JsAccessError>
    where
        F: Fn(&V) -> C,
        P: CachePolicy<V>,
    {
        on_flush(&self.config, state, at)
    }
    pub fn subs<V>(&self, state: &ThrottledInput<V>, id: Option<JsText>) -> Vec<Deadline> {
        subs_for(&self.config, state, id)
    }
}
