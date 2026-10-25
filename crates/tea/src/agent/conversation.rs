//! Conversation-only pure operations. Dense native sequences retain caller
//! handles without Clone, serde, Send or lifetime bounds on their values.
//! Undeclared JavaScript record properties are not part of Conversation.

use super::types::{AgentField, Awaiting, Conversation, ToolCall, ToolRecord, TurnUsage};
use crate::flow::fan_out::slice_start;
use std::{collections::HashSet, rc::Rc};

pub static NO_USAGE: TurnUsage = TurnUsage {
    input_tokens: 0.0,
    output_tokens: 0.0,
    reasoning_tokens: AgentField::Absent,
    cached_input_tokens: AgentField::Absent,
};

pub fn fresh_conversation<R>() -> Conversation<R> {
    Conversation::fresh()
}
impl<R, T, E, A> Conversation<R, T, E, A> {
    pub fn fresh() -> Self {
        Self {
            turns: Vec::new(),
            tool_records: Vec::new(),
            turn_count: 0.0,
            awaiting: Awaiting::Llm,
            context_tokens: AgentField::Value(None),
        }
    }
}

/// Arithmetic does not apply the structured-output guard. Totals can exceed a
/// single safe count; nonfinite inputs and signed zero follow f64 addition.
pub fn add_usage(total: &TurnUsage, turn: &TurnUsage) -> TurnUsage {
    let optional =
        |left: &AgentField<f64>, right: &AgentField<f64>| match (left.value(), right.value()) {
            (None, None) => AgentField::Absent,
            (left, right) => {
                AgentField::Value(left.copied().unwrap_or(0.0) + right.copied().unwrap_or(0.0))
            }
        };
    TurnUsage {
        input_tokens: total.input_tokens + turn.input_tokens,
        output_tokens: total.output_tokens + turn.output_tokens,
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
        .filter(|record| record.turn >= folding)
        .map(|record| {
            Rc::new(ToolRecord {
                call: Rc::clone(&record.call),
                outcome: Rc::clone(&record.outcome),
                turn: record.turn - shift,
            })
        })
        .collect();
    Conversation {
        turns,
        tool_records,
        turn_count: conversation.turn_count,
        awaiting: Awaiting::Llm,
        context_tokens: AgentField::Value(None),
    }
}
