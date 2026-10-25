use std::collections::VecDeque;
use std::fmt;
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;

use super::Gate;
use crate::Tagged;
use crate::command::{CommandContractError, DispatchGuard};

#[derive(Debug)]
pub enum DispatchRefused {
    Stopping { msg_type: String },
    Stopped { msg_type: String },
    Contract(Arc<CommandContractError>),
}
impl fmt::Display for DispatchRefused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for DispatchRefused {}
pub(crate) enum Notice {
    Refused(DispatchRefused),
}
#[derive(Clone, Copy)]
pub(crate) enum Origin {
    Caller,
    Producer,
}
pub(crate) enum Job<M> {
    Message {
        seq: u64,
        message: M,
        origin: Origin,
    },
    Barrier {
        seq: u64,
    },
}
impl<M> Job<M> {
    pub fn seq(&self) -> u64 {
        match self {
            Self::Message { seq, .. } | Self::Barrier { seq } => *seq,
        }
    }
}
pub(crate) struct Queue<M> {
    pub gate: Gate,
    pub tail: u64,
    pub completed: u64,
    pub jobs: VecDeque<Job<M>>,
    pub notices: VecDeque<Notice>,
}
pub(crate) struct Mailbox<M> {
    pub state: Mutex<Queue<M>>,
    pub changed: Notify,
}
impl<M> Mailbox<M> {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(Queue {
                gate: Gate::Open,
                tail: 1,
                completed: 0,
                jobs: VecDeque::new(),
                notices: VecDeque::new(),
            }),
            changed: Notify::new(),
        }
    }
    pub fn with<R>(&self, read: impl FnOnce(&mut Queue<M>) -> R) -> R {
        read(
            &mut self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }
    pub fn gate(&self) -> Gate {
        self.with(|queue| queue.gate)
    }
    pub fn completed(&self, seq: u64) {
        self.with(|queue| queue.completed = seq);
        self.changed.notify_waiters();
    }
    pub fn notice(&self, notice: Notice) {
        self.with(|queue| queue.notices.push_back(notice));
        self.changed.notify_waiters();
    }
    pub fn enqueue(&self, message: M, origin: Origin) -> Result<u64, DispatchRefused>
    where
        M: Tagged,
    {
        let result = self.with(|queue| {
            if queue.gate != Gate::Open {
                let msg_type = message.tag().into();
                return Err(
                    if queue.gate == Gate::Draining
                        || queue.gate == Gate::Abandoned && matches!(origin, Origin::Producer)
                    {
                        DispatchRefused::Stopping { msg_type }
                    } else {
                        DispatchRefused::Stopped { msg_type }
                    },
                );
            }
            queue.tail += 1;
            let seq = queue.tail;
            queue.jobs.push_back(Job::Message {
                seq,
                message,
                origin,
            });
            Ok(seq)
        });
        self.changed.notify_waiters();
        result
    }
    pub fn barrier(&self) -> u64 {
        let seq = self.with(|queue| {
            queue.tail += 1;
            let seq = queue.tail;
            queue.jobs.push_back(Job::Barrier { seq });
            seq
        });
        self.changed.notify_waiters();
        seq
    }
}
/// A narrow producer carries messages and owned guards, never local machine callbacks.
pub struct Producer<M> {
    pub(crate) mailbox: Arc<Mailbox<M>>,
    pub(crate) guard: Option<DispatchGuard<M>>,
}
impl<M> Clone for Producer<M> {
    fn clone(&self) -> Self {
        Self {
            mailbox: Arc::clone(&self.mailbox),
            guard: self.guard.clone(),
        }
    }
}
impl<M: Tagged> Producer<M> {
    pub fn emit(&self, message: M) -> Result<(), DispatchRefused> {
        if let Some(guard) = &self.guard
            && let Err(error) = guard.check(&message)
        {
            let error = Arc::new(error);
            // The owned guard is Send; the local sink consumes this notice separately.
            self.mailbox
                .notice(Notice::Refused(DispatchRefused::Contract(Arc::clone(
                    &error,
                ))));
            return Err(DispatchRefused::Contract(error));
        }
        match self.mailbox.enqueue(message, Origin::Producer) {
            Ok(_) => Ok(()),
            Err(error) => {
                let copy = match &error {
                    DispatchRefused::Stopping { msg_type } => DispatchRefused::Stopping {
                        msg_type: msg_type.clone(),
                    },
                    DispatchRefused::Stopped { msg_type } => DispatchRefused::Stopped {
                        msg_type: msg_type.clone(),
                    },
                    DispatchRefused::Contract(error) => {
                        DispatchRefused::Contract(Arc::clone(error))
                    }
                };
                self.mailbox.notice(Notice::Refused(copy));
                Err(error)
            }
        }
    }
}
pub type RuntimeRef<M> = Producer<M>;
