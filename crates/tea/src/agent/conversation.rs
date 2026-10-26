//! Conversation-only pure operations. Dense native sequences retain caller
//! handles without Clone, serde, Send or lifetime bounds on their values.
//! Undeclared JavaScript record properties are not part of Conversation.

use super::types::{
    AgentField, AgentNumber, Awaiting, Conversation, ToolCall, ToolRecord, TurnUsage,
};
use crate::flow::fan_out::slice_start;
use std::{collections::HashSet, rc::Rc};

pub static NO_USAGE: TurnUsage = TurnUsage {
    input_tokens: AgentNumber(Some(0.0)),
    output_tokens: AgentNumber(Some(0.0)),
    reasoning_tokens: AgentField::Absent,
    cached_input_tokens: AgentField::Absent,
};

thread_local! {static SHARED_NO_USAGE: Rc<TurnUsage> = Rc::new(NO_USAGE.clone());}
/// The canonical zero reading has one retained handle per local agent domain.
pub fn shared_no_usage() -> Rc<TurnUsage> {
    SHARED_NO_USAGE.with(Rc::clone)
}

pub fn fresh_conversation<R>() -> Conversation<R> {
    Conversation::fresh()
}
impl<R, T, E, A> Conversation<R, T, E, A> {
    pub fn fresh() -> Self {
        Self {
            turns: Rc::new(Vec::new()),
            tool_records: Rc::new(Vec::new()),
            turn_count: 0.0.into(),
            awaiting: Awaiting::Llm,
            context_tokens: AgentField::Value(AgentNumber(None)),
            legacy_usage: AgentField::Absent,
        }
    }
}

/// Arithmetic does not apply the structured-output guard. Totals can exceed a
/// single safe count; nonfinite inputs and signed zero follow f64 addition.
pub fn add_usage(total: &TurnUsage, turn: &TurnUsage) -> TurnUsage {
    let optional = |left: &AgentField<AgentNumber>, right: &AgentField<AgentNumber>| match (
        left.value(),
        right.value(),
    ) {
        (None, None) => AgentField::Absent,
        (left, right) => AgentField::Value(AgentNumber::from(
            left.copied().map_or(0.0, AgentNumber::number_or_zero)
                + right.copied().map_or(0.0, AgentNumber::number_or_zero),
        )),
    };
    TurnUsage {
        input_tokens: (total.input_tokens.number_or_zero() + turn.input_tokens.number_or_zero())
            .into(),
        output_tokens: (total.output_tokens.number_or_zero() + turn.output_tokens.number_or_zero())
            .into(),
        reasoning_tokens: optional(&total.reasoning_tokens, &turn.reasoning_tokens),
        cached_input_tokens: optional(&total.cached_input_tokens, &turn.cached_input_tokens),
    }
}

/// First occurrence wins; order and the original call handles are retained.
pub fn dedupe_by_call_id<A>(calls: &[Rc<ToolCall<A>>]) -> Vec<Rc<ToolCall<A>>> {
    let mut seen = HashSet::new();
    calls
        .iter()
        .filter(|call| seen.insert(&call.call_id))
        .map(Rc::clone)
        .collect()
}

/// The trigger normally supplies 2 <= folding <= turns.len(). This helper
/// also keeps the source's independent slice and numeric-filter behavior for
/// fractional, negative and nonfinite folding values; it adds no validation.
pub fn fold_summary<R, T, E, A>(
    conversation: &Conversation<R, T, E, A>,
    folding: f64,
    summary_turn: Rc<T>,
) -> Conversation<R, T, E, A> {
    let shift = folding - 1.0;
    let mut turns = Vec::with_capacity(conversation.turns.len() + 1);
    turns.push(summary_turn);
    turns.extend_from_slice(&conversation.turns[slice_start(folding, conversation.turns.len())..]);
    let tool_records = conversation
        .tool_records
        .iter()
        .filter(|record| record.turn.number_or_zero() >= folding)
        .map(|record| {
            Rc::new(ToolRecord {
                call: Rc::clone(&record.call),
                outcome: Rc::clone(&record.outcome),
                turn: (record.turn.number_or_zero() - shift).into(),
            })
        })
        .collect();
    Conversation {
        turns: Rc::new(turns),
        tool_records: Rc::new(tool_records),
        turn_count: conversation.turn_count,
        awaiting: Awaiting::Llm,
        context_tokens: AgentField::Value(AgentNumber(None)),
        legacy_usage: conversation.legacy_usage.clone(),
    }
}
