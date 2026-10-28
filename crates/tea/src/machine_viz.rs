//! Pure Mermaid output from the existing machine and caller-owned samples.
use crate::{
    Machine, Step, TryUpdate,
    core::ProjectionError,
    data::{JsText, Subscription},
    js_record::trim_js_units,
};
use indexmap::IndexMap;
use std::panic::{AssertUnwindSafe, catch_unwind};

pub fn safe_id(raw: impl Into<JsText>) -> String {
    let raw = raw.into();
    let mut cleaned: String = raw
        .as_units()
        .iter()
        .map(|unit| match *unit {
            65..=90 | 97..=122 | 48..=57 | 95 => char::from_u32(u32::from(*unit)).expect("ASCII"),
            _ => '_',
        })
        .collect();
    if cleaned.is_empty() {
        return "_empty".into();
    }
    if cleaned.as_bytes()[0].is_ascii_digit() {
        cleaned.insert_str(0, "s_");
    }
    cleaned
}

pub fn safe_label(raw: impl Into<JsText>) -> JsText {
    let raw = raw.into();
    let cleaned: Vec<_> = raw
        .as_units()
        .iter()
        .map(|unit| match *unit {
            34 | 10 | 13 | 59 | 58 => 32,
            _ => *unit,
        })
        .collect();
    JsText::from_units(trim_js_units(&cleaned).to_vec())
}

#[derive(Default, Clone, Copy)]
pub enum Direction {
    #[default]
    TB,
    LR,
}

pub struct Samples<'a, S, M, X> {
    pub states: IndexMap<String, &'a S>,
    pub messages: IndexMap<String, &'a M>,
    pub context: Option<&'a X>,
}
impl<S, M, X> Default for Samples<'_, S, M, X> {
    fn default() -> Self {
        Self {
            states: IndexMap::new(),
            messages: IndexMap::new(),
            context: None,
        }
    }
}
pub struct MachineVizOptions<'a, S, M, X> {
    pub samples: Samples<'a, S, M, X>,
    pub direction: Direction,
    pub title: Option<&'a JsText>,
}
impl<S, M, X> Default for MachineVizOptions<'_, S, M, X> {
    fn default() -> Self {
        Self {
            samples: Samples::default(),
            direction: Direction::default(),
            title: None,
        }
    }
}

fn keys<V>(map: &IndexMap<String, V>) -> Vec<&str> {
    ordered_keys(map.keys().map(String::as_str).collect())
}
fn ordered_keys(mut keys: Vec<&str>) -> Vec<&str> {
    let mut seen = std::collections::HashSet::new();
    keys.retain(|key| seen.insert(*key));
    keys.sort_by_key(|key| {
        JsText::from(*key)
            .array_index()
            .map_or((1, 0), |index| (0, index))
    });
    keys
}
fn label(text: &str) -> String {
    safe_label(text)
        .as_utf8()
        .expect("valid UTF-8 remains valid after ASCII replacement and trimming")
        .to_owned()
}

/// Render cells directly from their declared row, including mismatched samples.
/// Failed sample cells become structural edges; init and dependency failures propagate.
pub fn to_mermaid<S, M, C, U: Subscription, X, E>(
    machine: &Machine<'_, S, M, C, U, X, E>,
    options: MachineVizOptions<'_, S, M, X>,
) -> Result<JsText, ProjectionError<E>> {
    let mut lines: Vec<JsText> = Vec::new();
    if let Some(title) = options.title {
        lines.push("---".into());
        let mut units = "title: ".encode_utf16().collect::<Vec<_>>();
        units.extend_from_slice(title.as_units());
        lines.push(JsText::from_units(units));
        lines.push("---".into());
    }
    let mut text = vec![
        "stateDiagram-v2".to_owned(),
        format!(
            "  direction {}",
            match options.direction {
                Direction::TB => "TB",
                Direction::LR => "LR",
            }
        ),
    ];
    if let TryUpdate::RawTransitions { rows, state_tag } = &machine.update {
        let state_types = keys(rows);
        for state in &state_types {
            text.push(format!("  {}", safe_id(*state)));
        }
        if let Some(context) = options.samples.context {
            let Step { state, .. } = (machine.init)(None, context);
            text.push(format!("  [*] --> {}", safe_id(state_tag(&state))));
        } else {
            text.push(
                "  %% init edge omitted: no samples.ctx provided to run init(null, ctx)".into(),
            );
        }
        let mut structural = false;
        for state in &state_types {
            let row = &rows[*state];
            for message in keys(row) {
                let target = options
                    .samples
                    .states
                    .get(*state)
                    .zip(options.samples.messages.get(message))
                    .and_then(|(s, m)| {
                        catch_unwind(AssertUnwindSafe(|| {
                            state_tag(&row[message](s, m).state).to_owned()
                        }))
                        .ok()
                    });
                match target {
                    Some(target) => text.push(format!(
                        "  {} --> {} : {}",
                        safe_id(*state),
                        safe_id(target),
                        label(message)
                    )),
                    None => {
                        structural = true;
                        text.push(format!(
                            "  {} --> {} : {}?",
                            safe_id(*state),
                            safe_id(*state),
                            label(message)
                        ));
                    }
                }
            }
        }
        text.push(format!(
            "  note right of {}",
            safe_id(state_types.first().copied().unwrap_or("_empty"))
        ));
        text.push("    Transitions-form machine.".into());
        text.push("    Edge a --> b : msg = RESOLVED (cell executed with samples).".into());
        if structural {
            text.push(
                "    Self-loop a --> a : msg? = STRUCTURAL (no sample; target unresolved).".into(),
            );
        }
        text.push("  end note".into());
    } else {
        let messages: Vec<&str> = ordered_keys(match &machine.update {
            TryUpdate::RawReducer { row, .. } => keys(row),
            TryUpdate::Exhaustive { accepted_types, .. }
            | TryUpdate::Fallible { accepted_types, .. } => accepted_types.to_vec(),
            TryUpdate::FallibleWithTypes { accepted_types, .. } => {
                accepted_types.iter().map(String::as_str).collect()
            }
            TryUpdate::RawTransitions { .. } => unreachable!(),
        });
        text.push("  state ReducerMachine {".into());
        if messages.is_empty() {
            text.push("    [*] --> NoMsgs".into());
            text.push("    NoMsgs : \"(no msg variants — M is never)\"".into());
        } else {
            for message in &messages {
                text.push(format!("    {} : {}", safe_id(*message), label(message)));
            }
        }
        text.push("  }".into());
        text.push("  note right of ReducerMachine".into());
        text.push("    Reducer-form machine: flat dispatch keyed by msg.type.".into());
        text.push("    No phase graph — state is not a discriminated union over phases.".into());
        text.push(format!("    Handled msg types: {}", messages.len()));
        text.push("  end note".into());
    }
    let states = if machine.subscriptions.is_declared_empty() {
        Vec::new()
    } else {
        keys(&options.samples.states)
    };
    for state in states {
        let subscriptions = machine
            .subscriptions
            .desired(options.samples.states[state])?;
        // Preserve declarations and duplicates; runtime ID reconciliation is not this reader's job.
        if !subscriptions.is_empty() {
            text.push(format!("  note left of {}", safe_id(state)));
            text.push(format!(
                "    subs: {}",
                subscriptions
                    .iter()
                    .map(|sub| label(sub.kind()))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            text.push("  end note".into());
        } else {
            text.push(format!("  note left of {}", safe_id(state)));
            text.push("    (no active subs)".into());
            text.push("  end note".into());
        }
    }
    lines.extend(text.into_iter().map(JsText::from));
    let mut output = Vec::new();
    for (index, line) in lines.into_iter().enumerate() {
        if index > 0 {
            output.push(10);
        }
        output.extend_from_slice(line.as_units());
    }
    Ok(JsText::from_units(output))
}
