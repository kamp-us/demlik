//! Pure model messages retaining the conversation's original payload owners.

use super::{
    content::{MessageContent, Parts},
    turn_view::{CallOf, CallSource, NativeCalls},
    types::{AgentTurn, Conversation, ToolOutcome, ToolRecordOf},
};
use crate::{PlainData, data::JsText};
use std::{convert::Infallible, rc::Rc};

/// A temporary view. `None` is the published prompt's null, not a missing field.
pub struct AgentPrompt<
    'a,
    R,
    T = AgentTurn,
    E = PlainData,
    A = PlainData,
    V: CallSource<A> = NativeCalls,
> {
    pub instructions: Option<&'a JsText>,
    pub input: Option<&'a JsText>,
    pub conversation: &'a Conversation<R, T, E, A, V>,
}

/// Assistant and tool messages expose their original owners. A provider adapter
/// selects the Source message fields; serializing an entire turn would also
/// expose usage or other fields that are not part of an assistant message.
pub enum AgentMessage<
    R,
    T = AgentTurn,
    E = PlainData,
    A = PlainData,
    V: CallSource<A> = NativeCalls,
> {
    System(JsText),
    User(MessageContent),
    Assistant(Rc<T>),
    Tool {
        record: Rc<ToolRecordOf<R, E, A, V>>,
        parts: Option<Parts>,
    },
}

pub type PromptMessages<R, T = AgentTurn, E = PlainData, A = PlainData, V = NativeCalls> =
    Rc<Vec<AgentMessage<R, T, E, A, V>>>;

/// Render with no tool content. Each call returns a fresh batch, even if empty.
pub fn render_prompt<R, T, E, A, V: CallSource<A>>(
    prompt: &AgentPrompt<'_, R, T, E, A, V>,
) -> PromptMessages<R, T, E, A, V> {
    match render_prompt_with(prompt, |_, _| Ok::<_, Infallible>(None)) {
        Ok(messages) => messages,
        Err(never) => match never {},
    }
}

/// Render native or already schema-admitted raw turns. The callback runs for
/// every matching record, including errors, and its failure escapes unchanged.
pub fn render_prompt_with<R, T, E, A, V, F, X>(
    prompt: &AgentPrompt<'_, R, T, E, A, V>,
    mut parts_of: F,
) -> Result<PromptMessages<R, T, E, A, V>, X>
where
    V: CallSource<A>,
    F: FnMut(&CallOf<A, V>, &ToolOutcome<R, E>) -> Result<Option<Parts>, X>,
{
    let mut messages = Vec::new();
    if let Some(content) = prompt.instructions {
        messages.push(AgentMessage::System(content.clone()));
    }
    if let Some(content) = prompt.input {
        messages.push(AgentMessage::User(MessageContent::Text(content.clone())));
    }
    for (index, turn) in prompt.conversation.turns.iter().enumerate() {
        messages.push(AgentMessage::Assistant(Rc::clone(turn)));
        for record in prompt.conversation.tool_records.iter() {
            if record.turn == index as f64 {
                let parts = parts_of(&record.call, &record.outcome)?;
                messages.push(AgentMessage::Tool {
                    record: Rc::clone(record),
                    parts,
                });
            }
        }
    }
    Ok(Rc::new(messages))
}
