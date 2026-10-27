//! Closure-free pure operations on the canonical composed agent state.
use super::turn_view::CallSource;
use super::{
    conversation::shared_no_usage,
    types::{AgentField, AgentNumber, AgentState, AwaitingKind, SharedConversation},
};
use crate::{flow::monitored_run::RunPhase, work_queue::QueueItemStatus};
use std::rc::Rc;
impl<S, P, O, R, I, LE, TE, SE, A, T, CI, CO, CE, FE, V: CallSource<A>>
    AgentState<S, P, O, R, I, LE, TE, SE, A, T, CI, CO, CE, FE, V>
{
    /// First running input, even if the enclosing run has since been cancelled.
    pub fn current_stage(&self) -> Option<Rc<S>> {
        self.run
            .core
            .step_states
            .items()
            .iter()
            .find(|item| item.status == QueueItemStatus::Running)
            .map(|item| Rc::clone(&item.input))
    }
    /// A missing or undefined annotation differs from the explicit null live mark.
    pub fn is_settled(&self) -> bool {
        matches!(
            self.run.phase,
            RunPhase::Done { .. } | RunPhase::Failed { .. } | RunPhase::Cancelled { .. }
        ) || !matches!(self.failure, AgentField::Value(None))
    }
    pub fn require_awaiting(
        &self,
        kind: AwaitingKind,
    ) -> Option<&SharedConversation<R, T, TE, A, V>> {
        if self.is_settled() {
            return None;
        }
        let conversation = self.conversation.as_ref()?;
        (conversation.awaiting.kind() == kind).then_some(conversation)
    }
    /// No-op keeps the outer owner; migration copies only the state and conversation.
    pub fn with_usage_defaults(self: &Rc<Self>) -> Rc<Self> {
        let defined = matches!(self.usage, AgentField::Value(_));
        let current = defined
            && self.conversation.as_ref().is_none_or(|conv| {
                !matches!(conv.legacy_usage, AgentField::Value(_))
                    && matches!(conv.context_tokens, AgentField::Value(_))
            });
        if current {
            return Rc::clone(self);
        }
        let usage = match &self.usage {
            AgentField::Value(Some(usage)) => Rc::clone(usage),
            _ => self
                .conversation
                .as_ref()
                .and_then(|conv| match &conv.legacy_usage {
                    AgentField::Value(Some(usage)) => Some(Rc::clone(usage)),
                    _ => None,
                })
                .unwrap_or_else(shared_no_usage),
        };
        let conversation = self.conversation.as_ref().map(|conv| {
            let mut next = conv.as_ref().clone();
            next.legacy_usage = AgentField::Absent;
            if !matches!(next.context_tokens,AgentField::Value(value) if value.number().is_some()) {
                next.context_tokens = AgentField::Value(AgentNumber(None));
            }
            Rc::new(next)
        });
        let mut next = self.as_ref().clone();
        next.usage = AgentField::Value(Some(usage));
        next.conversation = conversation;
        Rc::new(next)
    }
}
