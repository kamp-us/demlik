//! Durable per-tool retry and timeout policies over the existing resilient call.
use crate::retry_backoff::{AnyRetryPolicy, RetryBudget, RetryPolicy};
use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResilience {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<AnyRetryPolicy>,
}
impl ToolResilience {
    pub fn timeout_ms(mut self, value: f64) -> Self {
        self.timeout_ms = Some(value);
        self
    }
    pub fn retry<B: Into<RetryBudget>>(mut self, policy: RetryPolicy<B>) -> Self {
        self.retry = Some(policy.into_any());
        self
    }
}

use crate::{
    PlainData,
    data::{JsText, stringify_json},
    js_record::{self, JsAccessError, JsRecord, RecordValue},
    resilience::{
        deadline::{Deadline, DeadlineExceeded},
        resilient_call as rc,
    },
};
use indexmap::IndexMap;
use std::{cell::RefCell, fmt, rc::Rc};

pub const TOOL_TIMEOUT_TAG: &str = "timeout";
pub const TOOL_RETRY_EXHAUSTED_TAG: &str = "retry_exhausted";

#[derive(Debug)]
pub enum ToolResilienceError {
    Resilience(rc::ResilientError),
    Access(JsAccessError),
    InheritedSlice { key: JsText },
    MissingFailureFamily,
    MissingCallInput,
    ToolMapping(Rc<super::tool::ToolError>),
}
impl ToolResilienceError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Access(e) => e.name,
            Self::ToolMapping(e) => e.name(),
            Self::InheritedSlice { .. } => "TypeError",
            _ => "AgentToolResilienceError",
        }
    }
}
impl fmt::Display for ToolResilienceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Resilience(e) => write!(f, "{e:?}"),
            Self::Access(e) => e.fmt(f),
            Self::ToolMapping(e) => e.fmt(f),
            Self::InheritedSlice { key } => match key.as_utf8() {
                Some(key) => write!(f, "Cannot read properties of undefined (reading '{key}')"),
                None => write!(
                    f,
                    "Cannot read inherited tool slice for UTF-16 key {:?}",
                    key.as_units()
                ),
            },
            Self::MissingFailureFamily => {
                f.write_str("tool policy requires its declared failure constructors")
            }
            Self::MissingCallInput => {
                f.write_str("tool policy requires the original typed call input")
            }
        }
    }
}
impl std::error::Error for ToolResilienceError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Access(e) => Some(e),
            Self::ToolMapping(e) => Some(e.as_ref()),
            _ => None,
        }
    }
}
impl From<rc::ResilientError> for ToolResilienceError {
    fn from(e: rc::ResilientError) -> Self {
        Self::Resilience(e)
    }
}
impl From<JsAccessError> for ToolResilienceError {
    fn from(e: JsAccessError) -> Self {
        Self::Access(e)
    }
}

/// Only the enabled PlainData profile supplies these source-owned endings.
/// A no-policy opaque error family never needs conversion or serialization.
pub(crate) struct FailureRelations<E> {
    timeout: fn() -> Rc<E>,
    exhausted: fn(f64, &Rc<E>) -> Result<Rc<E>, JsAccessError>,
    deadline: fn(&rc::CallFailure<E>) -> bool,
}
impl FailureRelations<PlainData> {
    pub(crate) fn plain() -> Self {
        Self {
            timeout: || Rc::new(tagged(TOOL_TIMEOUT_TAG, vec![])),
            exhausted: |attempts, last| {
                Ok(Rc::new(tagged(
                    TOOL_RETRY_EXHAUSTED_TAG,
                    vec![
                        ("attempts", PlainData::Number(attempts)),
                        ("last", js_record::property(last, "reason")?),
                    ],
                )))
            },
            deadline: |error| match error {
                rc::CallFailure::DeadlineExceeded { .. } => true,
                rc::CallFailure::Run(error) => {
                    matches!(error.kind, rc::RunErrorKind::DeadlineExceeded)
                }
                rc::CallFailure::External(value) => {
                    matches!(value.as_ref(),PlainData::Object(fields)if matches!(fields.get("_tag"),Some(PlainData::String(tag))if tag.as_utf8()==Some("deadline_exceeded")))
                }
                _ => false,
            },
        }
    }
}
fn tagged(tag: &str, detail: Vec<(&str, PlainData)>) -> PlainData {
    let mut fields = IndexMap::new();
    fields.insert("_tag".into(), PlainData::String(tag.into()));
    let data = PlainData::Object(
        detail
            .iter()
            .map(|(k, v)| ((*k).into(), v.clone()))
            .collect(),
    );
    let reason = if detail.is_empty() {
        tag.into()
    } else {
        let json =
            stringify_json(&data).expect("tagged failure contains only canonical plain data");
        JsText::from_units(
            [
                format!("{tag} ").encode_utf16().collect::<Vec<_>>(),
                json.encode_utf16().collect(),
            ]
            .concat(),
        )
    };
    fields.extend(detail.into_iter().map(|(k, v)| (k.into(), v)));
    fields.insert("reason".into(), PlainData::String(reason));
    fields.insert("kind".into(), PlainData::String("error".into()));
    PlainData::Object(fields)
}

pub(crate) type ToolMap<I, E> = Rc<JsRecord<rc::State<I, (), E>>>;
pub(crate) type Selector<'a, I> = Box<dyn Fn(&Rc<I>) -> Option<ToolResilience> + 'a>;
type Family<'a, I, E> = rc::ResilientCall<'a, I, (), E, RetryBudget>;
type Cache<'a, I, E> = RefCell<IndexMap<JsText, Rc<Family<'a, I, E>>>>;
type Emit<'a, I, C> = Rc<dyn Fn(&Rc<I>) -> Result<C, Rc<super::tool::ToolError>> + 'a>;
type LadderStep<I, E, O> = Result<(ToolMap<I, E>, O), ToolResilienceError>;
pub(crate) struct SettleOrder<E> {
    pub id: JsText,
    pub failure: Rc<E>,
}
pub(crate) struct TimerOutcome<C, E> {
    pub commands: Vec<C>,
    pub settle: Vec<SettleOrder<E>>,
}
impl<C, E> TimerOutcome<C, E> {
    fn empty() -> Self {
        Self {
            commands: vec![],
            settle: vec![],
        }
    }
}
pub(crate) struct ToolLadder<'a, I, C, E> {
    seed: Family<'a, I, E>,
    select: Option<Selector<'a, I>>,
    emit: Emit<'a, I, C>,
    name: fn(&I) -> &JsText,
    id: fn(&I) -> &JsText,
    failures: Option<FailureRelations<E>>,
    instances: Cache<'a, I, E>,
}
impl<'a, I, C, E> ToolLadder<'a, I, C, E> {
    pub(crate) fn new(
        seed: Family<'a, I, E>,
        select: Option<Selector<'a, I>>,
        emit: Emit<'a, I, C>,
        name: fn(&I) -> &JsText,
        id: fn(&I) -> &JsText,
        failures: Option<FailureRelations<E>>,
    ) -> Self {
        Self {
            seed,
            select,
            emit,
            name,
            id,
            failures,
            instances: RefCell::new(IndexMap::new()),
        }
    }
    fn rc_for(&self, call: &Rc<I>) -> Option<Rc<Family<'a, I, E>>> {
        let policy = self.select.as_ref()?(call)?;
        if policy.timeout_ms.is_none() && policy.retry.is_none() {
            return None;
        }
        let name = (self.name)(call);
        if let Some(cached) = self.instances.borrow().get(name) {
            return Some(Rc::clone(cached));
        }
        let made = Rc::new(self.seed.retry_sibling_with(rc::Config {
            retry: policy.retry,
            deadline: policy.timeout_ms.map(|ms| rc::DeadlineConfig { ms }),
            ..Default::default()
        }));
        self.instances
            .borrow_mut()
            .insert(name.clone(), Rc::clone(&made));
        Some(made)
    }
    fn slice(
        &self,
        s: &ToolMap<I, E>,
        name: &JsText,
        rc: &Family<'a, I, E>,
        key: &JsText,
    ) -> Result<rc::State<I, (), E>, ToolResilienceError> {
        match s.own_value(name) {
            Some(RecordValue::Entry(slice)) => Ok(slice.clone()),
            Some(RecordValue::Data(PlainData::Null | PlainData::Undefined)) => Ok(rc.init()),
            Some(_) => Err(ToolResilienceError::Access(JsAccessError {
                name: "TypeError",
                message: "tool resilience slice needs its typed boundary decoder".into(),
            })),
            None if name.as_utf8() == Some("__proto__")
                || name.as_utf8().and_then(js_record::builtin).is_some() =>
            {
                Err(ToolResilienceError::InheritedSlice { key: key.clone() })
            }
            None => Ok(rc.init()),
        }
    }
    fn put(s: &ToolMap<I, E>, name: JsText, slice: rc::State<I, (), E>) -> ToolMap<I, E> {
        let mut map = s.spread();
        map.define(name, RecordValue::Entry(slice));
        Rc::new(map)
    }
    fn cmds(&self, commands: Vec<rc::RunCommand<I, (), E>>) -> Result<Vec<C>, ToolResilienceError> {
        commands
            .into_iter()
            .map(|cmd| match cmd.into_input().input {
                rc::CallValue::Shared(call) => {
                    (self.emit)(&call).map_err(ToolResilienceError::ToolMapping)
                }
                _ => Err(ToolResilienceError::MissingCallInput),
            })
            .collect()
    }
    pub(crate) fn launch(
        &self,
        s: &ToolMap<I, E>,
        calls: &[Rc<I>],
        at: f64,
    ) -> LadderStep<I, E, Vec<C>> {
        let mut next = Rc::clone(s);
        let mut commands = vec![];
        for call in calls {
            let Some(rc) = self.rc_for(call) else {
                commands.push((self.emit)(call).map_err(ToolResilienceError::ToolMapping)?);
                continue;
            };
            let name = (self.name)(call);
            let key = tool_key(name, (self.id)(call));
            let step = rc.attempt(
                &self.slice(&next, name, &rc, &key)?,
                key,
                rc::CallValue::shared(Rc::clone(call)),
                at,
            )?;
            next = Self::put(&next, name.clone(), step.state);
            commands.extend(self.cmds(step.commands)?);
        }
        Ok((next, commands))
    }
    pub(crate) fn ok(
        &self,
        s: &ToolMap<I, E>,
        call: &Rc<I>,
        at: f64,
    ) -> Result<ToolMap<I, E>, ToolResilienceError> {
        let Some(rc) = self.rc_for(call) else {
            return Ok(Rc::clone(s));
        };
        let name = (self.name)(call);
        let key = tool_key(name, (self.id)(call));
        let settled = rc.settle(
            &self.slice(s, name, &rc, &key)?,
            rc::SettleInput::Ok {
                key: key.clone(),
                value: rc::CallValue::value(()),
                at: at.into(),
            },
        )?;
        Ok(Self::put(s, name.clone(), forget(&settled.call, &key)))
    }
    pub(crate) fn err(
        &self,
        s: &ToolMap<I, E>,
        call: &Rc<I>,
        failure: Rc<E>,
        at: f64,
    ) -> LadderStep<I, E, Option<Rc<E>>> {
        let Some(rc) = self.rc_for(call) else {
            return Ok((Rc::clone(s), Some(failure)));
        };
        let name = (self.name)(call);
        let key = tool_key(name, (self.id)(call));
        let before = self.slice(s, name, &rc, &key)?;
        let settled = rc.settle(
            &before,
            rc::SettleInput::Err {
                key: key.clone(),
                error: Rc::new(rc::CallFailure::External(Rc::clone(&failure))),
                at: at.into(),
            },
        )?;
        if matches!(settled.outcome, rc::SettleOutcome::Retrying) {
            return Ok((Self::put(s, name.clone(), settled.call), None));
        }
        let retry = self
            .select
            .as_ref()
            .and_then(|select| select(call))
            .and_then(|p| p.retry);
        let error = if retry.is_none() {
            failure
        } else {
            let attempts = match before.snapshot().retry.own_value(&key) {
                Some(RecordValue::Entry(progress)) => progress.attempt.number_or_zero(),
                _ => 0.0,
            };
            (self
                .failures
                .as_ref()
                .ok_or(ToolResilienceError::MissingFailureFamily)?
                .exhausted)(attempts + 1.0, &failure)?
        };
        Ok((
            Self::put(s, name.clone(), forget(&settled.call, &key)),
            Some(error),
        ))
    }
    pub(crate) fn on_timer(
        &self,
        s: &ToolMap<I, E>,
        msg: &DeadlineExceeded,
    ) -> LadderStep<I, E, TimerOutcome<C, E>> {
        let Some(key) = timer_key(&msg.id) else {
            return Ok((Rc::clone(s), TimerOutcome::empty()));
        };
        let Some((name, id)) = read_key(&key) else {
            return Ok((Rc::clone(s), TimerOutcome::empty()));
        };
        let slice = match s.own_value(&name) {
            Some(RecordValue::Entry(slice)) => slice,
            None if name.as_utf8() == Some("__proto__")
                || name.as_utf8().and_then(js_record::builtin).is_some() =>
            {
                return Err(ToolResilienceError::InheritedSlice { key });
            }
            None => return Ok((Rc::clone(s), TimerOutcome::empty())),
            _ => {
                return Err(JsAccessError {
                    name: "TypeError",
                    message: "tool resilience timer needs its typed slice".into(),
                }
                .into());
            }
        };
        let Some(call) = input_of(slice, &key)? else {
            return Ok((Rc::clone(s), TimerOutcome::empty()));
        };
        let Some(rc) = self.rc_for(&call) else {
            return Ok((Rc::clone(s), TimerOutcome::empty()));
        };
        let step = rc.on_timer(slice, msg)?;
        if let Some(rc::CallPhase::Failed { error }) = step.state.call(&key)
            && (self
                .failures
                .as_ref()
                .ok_or(ToolResilienceError::MissingFailureFamily)?
                .deadline)(error)
        {
            return Ok((
                Self::put(s, name, forget(&step.state, &key)),
                TimerOutcome {
                    commands: vec![],
                    settle: vec![SettleOrder {
                        id,
                        failure: (self
                            .failures
                            .as_ref()
                            .ok_or(ToolResilienceError::MissingFailureFamily)?
                            .timeout)(),
                    }],
                },
            ));
        }
        Ok((
            Self::put(s, name, step.state),
            TimerOutcome {
                commands: self.cmds(step.commands)?,
                settle: vec![],
            },
        ))
    }
    pub(crate) fn boot(
        &self,
        s: &ToolMap<I, E>,
        calls: &[Rc<I>],
        at: f64,
    ) -> LadderStep<I, E, TimerOutcome<C, E>> {
        let mut next = Rc::clone(s);
        let mut outcome = TimerOutcome::empty();
        for call in calls {
            let Some(rc) = self.rc_for(call) else {
                outcome
                    .commands
                    .push((self.emit)(call).map_err(ToolResilienceError::ToolMapping)?);
                continue;
            };
            let name = (self.name)(call);
            let key = tool_key(name, (self.id)(call));
            let resumed = rc.resume(&self.slice(&next, name, &rc, &key)?, at);
            next = Self::put(&next, name.clone(), resumed);
            let before = self.slice(&next, name, &rc, &key)?;
            if matches!(before.call(&key), Some(rc::CallPhase::WaitingRetry { .. })) {
                continue;
            }
            let step = rc.attempt(
                &before,
                key.clone(),
                rc::CallValue::shared(Rc::clone(call)),
                at,
            )?;
            if let Some(rc::CallPhase::Failed { error }) = step.state.call(&key)
                && (self
                    .failures
                    .as_ref()
                    .ok_or(ToolResilienceError::MissingFailureFamily)?
                    .deadline)(error)
            {
                next = Self::put(&next, name.clone(), forget(&step.state, &key));
                outcome.settle.push(SettleOrder {
                    id: (self.id)(call).clone(),
                    failure: (self
                        .failures
                        .as_ref()
                        .ok_or(ToolResilienceError::MissingFailureFamily)?
                        .timeout)(),
                });
                continue;
            }
            next = Self::put(&next, name.clone(), step.state);
            outcome.commands.extend(self.cmds(step.commands)?);
        }
        Ok((next, outcome))
    }
    pub(crate) fn subs(&self, s: &ToolMap<I, E>) -> Result<Vec<Deadline>, ToolResilienceError> {
        let mut deadlines = vec![];
        for (_, slice) in s.own_entries() {
            let RecordValue::Entry(slice) = slice else {
                return Err(JsAccessError {
                    name: "TypeError",
                    message: "tool resilience subscriptions need their typed slice".into(),
                }
                .into());
            };
            let mut sample = None;
            for (key, _) in slice.snapshot().calls.own_entries() {
                if let Some(call) = input_of(slice, key)? {
                    sample = Some(call);
                    break;
                }
            }
            if let Some(call) = sample
                && let Some(rc) = self.rc_for(&call)
            {
                deadlines.extend(rc.deadlines(slice));
            }
        }
        Ok(deadlines)
    }
}
fn forget<I, E>(s: &rc::State<I, (), E>, key: &JsText) -> rc::State<I, (), E> {
    let mut snapshot = s.snapshot().clone();
    let mut calls = snapshot.calls.spread();
    calls.delete(key);
    let mut retry = snapshot.retry.spread();
    retry.delete(key);
    snapshot.calls = Rc::new(calls);
    snapshot.retry = Rc::new(retry);
    rc::State::from_snapshot(snapshot)
}
fn input_of<I, E>(
    s: &rc::State<I, (), E>,
    key: &JsText,
) -> Result<Option<Rc<I>>, ToolResilienceError> {
    match s.call(key) {
        Some(rc::CallPhase::Running { input, .. } | rc::CallPhase::WaitingRetry { input, .. }) => {
            match input {
                rc::CallValue::Shared(input) => Ok(Some(Rc::clone(input))),
                _ => Err(ToolResilienceError::MissingCallInput),
            }
        }
        _ => Ok(None),
    }
}
fn tool_key(name: &JsText, id: &JsText) -> JsText {
    JsText::from_units(
        [
            "$tool:".encode_utf16().collect::<Vec<_>>(),
            name.as_units().to_vec(),
            vec![35],
            id.as_units().to_vec(),
        ]
        .concat(),
    )
}
fn timer_key(id: &JsText) -> Option<JsText> {
    ["resilient:retry:", "resilient:deadline:"]
        .into_iter()
        .find_map(|prefix| {
            let p = prefix.encode_utf16().collect::<Vec<_>>();
            id.as_units()
                .strip_prefix(p.as_slice())
                .filter(|key| key.starts_with(&"$tool:".encode_utf16().collect::<Vec<_>>()))
                .map(|key| JsText::from_units(key.to_vec()))
        })
}
fn read_key(key: &JsText) -> Option<(JsText, JsText)> {
    let body = key
        .as_units()
        .strip_prefix("$tool:".encode_utf16().collect::<Vec<_>>().as_slice())?;
    let at = body.iter().position(|c| *c == 35)?;
    if at == 0 {
        return None;
    }
    Some((
        JsText::from_units(body[..at].to_vec()),
        JsText::from_units(body[at + 1..].to_vec()),
    ))
}
pub(crate) fn is_tool_timer(id: &JsText) -> bool {
    timer_key(id).is_some()
}
