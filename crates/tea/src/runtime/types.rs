use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;
use std::{convert::Infallible, fmt};

use serde::Serialize;

use crate::NoCellError;
use crate::command::CommandContractError;
use crate::storage::{PanicCause, StoreRefusedError};

use super::{EventProjector, NoEvent, Persistence, Telemetry};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    Promise,
    Effect,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    Open,
    Draining,
    Closed,
    Abandoned,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorPhase {
    Reduce,
    Interpret,
    Sub,
    SubCleanup,
    StopSave,
    Discard,
    FollowUp,
    Listener,
    Observer,
    PortEmit,
    Event,
    Boot,
    IdentityDrop,
}

#[derive(Debug)]
pub enum RuntimeError<SE, HE, RE = Infallible> {
    IdentityDrop(IdentityDropNotice),
    Timer(crate::timing::TimerError),
    NoCell(NoCellError),
    Reduce(RE),
    Restore(StoreRefusedError<SE>),
    Save(SE),
    Handler(HE),
    Contract(Arc<CommandContractError>),
    Panic(PanicCause),
    Cleanup {
        prior: Option<Failure<SE, HE, RE>>,
        cause: Failure<SE, HE, RE>,
    },
    Stopped {
        msg_type: String,
    },
    Discarded {
        msg_type: String,
    },
    QuiescenceTimeout {
        cap: usize,
    },
    RuntimeDiscarded {
        pending: usize,
    },
    DrainTimeout {
        cmd_types: Vec<String>,
        pending: usize,
        timeout: Duration,
    },
    DisposeTimeout {
        pending: usize,
        timeout: Duration,
    },
    Projection {
        failures: Vec<crate::core::ProjectionFailure<RE>>,
    },
    MissingSubscription {
        kind: String,
    },
}
impl<SE, HE, RE> RuntimeError<SE, HE, RE> {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Timer(_) => "TimerError",
            Self::IdentityDrop(_) => "IdentityDropNotice",
            Self::NoCell(_) => "NoCellError",
            Self::Reduce(_) => "ReduceError",
            Self::Restore(_) => "StoreRefusedError",
            Self::Save(_) => "StoreFailed",
            Self::Handler(_) => "CellFailure",
            Self::Contract(error) => error.name(),
            Self::Panic(_) => "Panic",
            Self::Cleanup { .. } => "CleanupFailed",
            Self::Stopped { .. } => "RuntimeStoppedError",
            Self::Discarded { .. } => "DispatchDiscardedError",
            Self::QuiescenceTimeout { .. } => "QuiescenceTimeoutError",
            Self::RuntimeDiscarded { .. } => "RuntimeDiscardedError",
            Self::DrainTimeout { .. } => "DrainTimeoutNotice",
            Self::DisposeTimeout { .. } => "DisposeTimeoutNotice",
            Self::MissingSubscription { .. } => "MissingSubscriptionRunner",
            Self::Projection { .. } => "SubscriptionProjectionError",
        }
    }
    pub fn discarded(&self) -> bool {
        matches!(self, Self::Discarded { .. })
    }
}

#[derive(Debug)]
pub struct IdentityDropNotice {
    pub msg_type: String,
}
impl IdentityDropNotice {
    pub fn name(&self) -> &'static str {
        "IdentityDropNotice"
    }
}
impl fmt::Display for IdentityDropNotice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "@demlik/tea: Msg \"{}\" was addressed to a different instance than this state owns and was dropped before `update` ran — the machine's `identity` filter working as declared. If this Msg was meant for THIS instance, its `ofMsg` projection disagrees with `ofState`; if the instance is being reused across runs, route the message to the run that owns it.",
            self.msg_type
        )
    }
}
impl std::error::Error for IdentityDropNotice {}
impl Serialize for IdentityDropNotice {
    fn serialize<T: serde::Serializer>(&self, serializer: T) -> Result<T::Ok, T::Error> {
        use serde::ser::SerializeStruct;
        let mut error = serializer.serialize_struct(self.name(), 4)?;
        error.serialize_field("name", self.name())?;
        error.serialize_field("_tag", self.name())?;
        error.serialize_field("message", &self.to_string())?;
        error.serialize_field("msgType", &self.msg_type)?;
        error.end()
    }
}
impl<SE: fmt::Debug, HE: fmt::Debug, RE: fmt::Debug> fmt::Display for RuntimeError<SE, HE, RE> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {self:?}", self.name())
    }
}
impl<SE: fmt::Debug, HE: fmt::Debug, RE: fmt::Debug> std::error::Error
    for RuntimeError<SE, HE, RE>
{
}

pub struct Report<SE, HE, RE = Infallible> {
    pub phase: ErrorPhase,
    pub error: Rc<RuntimeError<SE, HE, RE>>,
}
impl<SE, HE, RE> Clone for Report<SE, HE, RE> {
    fn clone(&self) -> Self {
        Self {
            phase: self.phase,
            error: Rc::clone(&self.error),
        }
    }
}
pub type Failure<SE, HE, RE = Infallible> = Rc<RuntimeError<SE, HE, RE>>;
pub type Commit<S, M> = Rc<dyn Fn(Option<&M>, &S)>;
pub type ErrorSink<SE, HE, RE = Infallible> = Rc<dyn Fn(&RuntimeError<SE, HE, RE>, ErrorPhase)>;
pub type Terminal<S> = Rc<dyn Fn(&S) -> bool>;
pub type Rehydrate<S, M, SE, HE, RE = Infallible> =
    Rc<dyn Fn(&S, &M, &RuntimeError<SE, HE, RE>) -> S>;
pub enum Supervision<S, M, SE, HE, RE = Infallible> {
    Stop,
    Escalate,
    Restart(Rehydrate<S, M, SE, HE, RE>),
}
pub struct Options<S, M, SE = Infallible, HE = Infallible, E = NoEvent, RE = Infallible> {
    pub events: Option<EventProjector<S, M, E>>,
    pub telemetry: Option<Telemetry<HE>>,
    pub timer: Option<super::RuntimeTimer>,
    pub profile: Profile,
    pub store: Option<Persistence<S, SE>>,
    pub terminal: Option<Terminal<S>>,
    pub on_commit: Vec<Commit<S, M>>,
    pub on_error: Option<ErrorSink<SE, HE, RE>>,
    pub clock: Rc<dyn Fn() -> f64>,
    pub dispose_timeout: Duration,
    pub idle_cap: usize,
    pub supervision: Supervision<S, M, SE, HE, RE>,
}
impl<S, M, SE, HE, RE> Options<S, M, SE, HE, NoEvent, RE> {
    pub fn new(profile: Profile) -> Self {
        Self {
            events: None,
            telemetry: None,
            timer: None,
            profile,
            store: None,
            terminal: None,
            on_commit: vec![],
            on_error: None,
            clock: Rc::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as f64
            }),
            dispose_timeout: Duration::from_secs(5),
            idle_cap: 100_000,
            supervision: Supervision::Stop,
        }
    }
}
impl<S, M, SE, HE, E, RE> Options<S, M, SE, HE, E, RE> {
    pub fn with_events<F: 'static>(
        self,
        project: impl Fn(&M, &S) -> Vec<F> + 'static,
    ) -> Options<S, M, SE, HE, F, RE> {
        Options {
            profile: self.profile,
            store: self.store,
            terminal: self.terminal,
            on_commit: self.on_commit,
            on_error: self.on_error,
            clock: self.clock,
            dispose_timeout: self.dispose_timeout,
            idle_cap: self.idle_cap,
            supervision: self.supervision,
            events: Some(Rc::new(project)),
            telemetry: self.telemetry,
            timer: self.timer,
        }
    }
}
