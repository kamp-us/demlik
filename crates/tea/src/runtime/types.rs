use std::fmt;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use crate::NoCellError;
use crate::command::CommandContractError;
use crate::storage::{PanicCause, StoreRefusedError};

use super::Persistence;

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
    Boot,
    IdentityDrop,
}

#[derive(Debug)]
pub enum RuntimeError<SE, HE> {
    NoCell(NoCellError),
    Restore(StoreRefusedError<SE>),
    Save(SE),
    Handler(HE),
    Contract(Arc<CommandContractError>),
    Panic(PanicCause),
    Cleanup {
        prior: Option<Failure<SE, HE>>,
        cause: Failure<SE, HE>,
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
    MissingSubscription {
        kind: String,
    },
}
impl<SE, HE> RuntimeError<SE, HE> {
    pub fn name(&self) -> &'static str {
        match self {
            Self::NoCell(_) => "NoCellError",
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
        }
    }
    pub fn discarded(&self) -> bool {
        matches!(self, Self::Discarded { .. })
    }
}
impl<SE: fmt::Debug, HE: fmt::Debug> fmt::Display for RuntimeError<SE, HE> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {self:?}", self.name())
    }
}
impl<SE: fmt::Debug, HE: fmt::Debug> std::error::Error for RuntimeError<SE, HE> {}

pub struct Report<SE, HE> {
    pub phase: ErrorPhase,
    pub error: Rc<RuntimeError<SE, HE>>,
}
impl<SE, HE> Clone for Report<SE, HE> {
    fn clone(&self) -> Self {
        Self {
            phase: self.phase,
            error: Rc::clone(&self.error),
        }
    }
}
pub type Failure<SE, HE> = Rc<RuntimeError<SE, HE>>;
pub type Commit<S, M> = Rc<dyn Fn(Option<&M>, &S)>;
pub type ErrorSink<SE, HE> = Rc<dyn Fn(&RuntimeError<SE, HE>, ErrorPhase)>;
pub type Terminal<S> = Rc<dyn Fn(&S) -> bool>;
pub type Rehydrate<S, M, SE, HE> = Rc<dyn Fn(&S, &M, &RuntimeError<SE, HE>) -> S>;
pub enum Supervision<S, M, SE, HE> {
    Stop,
    Escalate,
    Restart(Rehydrate<S, M, SE, HE>),
}
pub struct Options<S, M, SE = std::convert::Infallible, HE = std::convert::Infallible> {
    pub profile: Profile,
    pub store: Option<Persistence<S, SE>>,
    pub terminal: Option<Terminal<S>>,
    pub on_commit: Vec<Commit<S, M>>,
    pub on_error: Option<ErrorSink<SE, HE>>,
    pub clock: Rc<dyn Fn() -> f64>,
    pub dispose_timeout: Duration,
    pub idle_cap: usize,
    pub supervision: Supervision<S, M, SE, HE>,
}
impl<S, M, SE, HE> Options<S, M, SE, HE> {
    pub fn new(profile: Profile) -> Self {
        Self {
            profile,
            store: None,
            terminal: None,
            on_commit: vec![],
            on_error: None,
            clock: Rc::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs_f64()
                    * 1000.0
            }),
            dispose_timeout: Duration::from_secs(5),
            idle_cap: 100_000,
            supervision: Supervision::Stop,
        }
    }
}
