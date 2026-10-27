use std::cell::Cell;

use demlik_tea::core::Row;
use demlik_tea::{Machine, Step, Sub, Tagged, Update};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize, Serialize)]
struct State {
    #[serde(rename = "type")]
    kind: String,
    count: f64,
}
impl Tagged for State {
    fn tag(&self) -> &str {
        &self.kind
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Msg {
    Add { by: f64 },
    Finish,
    Unknown,
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Add { .. } => "add",
            Self::Finish => "finish",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Serialize)]
struct Cmd {
    #[serde(rename = "type")]
    kind: &'static str,
    count: f64,
}

#[derive(Serialize)]
struct PulseDeps {
    count: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Form {
    Reducer,
    Transitions,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Replay,
    Fold,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    form: Form,
    mode: Mode,
    base: Option<State>,
    loaded: Option<State>,
    initial_count: f64,
    restored_bump: f64,
    msgs: Vec<Msg>,
}

fn row() -> Row<'static, State, Msg, Cmd> {
    Row::from([
        (
            "add".into(),
            Box::new(|state: &State, msg: &Msg| {
                let Msg::Add { by } = msg else {
                    unreachable!("add cell receives add messages")
                };
                Step::new(
                    State {
                        kind: state.kind.clone(),
                        count: state.count + by,
                    },
                    vec![Cmd {
                        kind: "added",
                        count: *by,
                    }],
                )
            }) as demlik_tea::core::Cell<'static, State, Msg, Cmd>,
        ),
        (
            "finish".into(),
            Box::new(|state: &State, _: &Msg| {
                Step::new(
                    State {
                        kind: "done".into(),
                        count: state.count,
                    },
                    vec![Cmd {
                        kind: "finished",
                        count: state.count,
                    }],
                )
            }),
        ),
    ])
}

pub fn execute(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let init_calls = Cell::new(0);
    let deps_calls = Cell::new(0);
    let machine = Machine {
        init: Box::new(|loaded: Option<State>, _: &()| {
            init_calls.set(init_calls.get() + 1);
            let (state, kind) = match loaded {
                Some(state) => (
                    State {
                        kind: state.kind,
                        count: state.count + input.restored_bump,
                    },
                    "resume",
                ),
                None => (
                    State {
                        kind: "ready".into(),
                        count: input.initial_count,
                    },
                    "boot",
                ),
            };
            let count = state.count;
            Step::new(state, vec![Cmd { kind, count }])
        }),
        update: match input.form {
            Form::Reducer => Update::raw_reducer(row()),
            Form::Transitions => Update::raw_transitions(
                [("ready".into(), row()), ("done".into(), Row::new())].into(),
            ),
        },
        subscriptions: Box::new(|state: &State| {
            deps_calls.set(deps_calls.get() + 2);
            if state.kind == "ready" {
                vec![
                    Sub::new("pulse", PulseDeps { count: state.count })
                        .expect("numeric dependencies are serializable"),
                    Sub::new("pulse", PulseDeps { count: state.count })
                        .expect("numeric dependencies are serializable"),
                ]
            } else {
                vec![]
            }
        }),
    };
    let result = match input.mode {
        Mode::Replay => observe!(
            calls,
            demlik_tea::core::replay,
            &machine,
            input.loaded,
            &(),
            input.msgs
        )
        .map(|result| json!(result)),
        Mode::Fold => observe!(
            calls,
            demlik_tea::core::fold_msgs,
            &machine,
            input.base.unwrap_or(State {
                kind: "ready".into(),
                count: 0.0,
            }),
            input.msgs,
        )
        .map(|state| json!({ "state": state })),
    };
    let mut output = match result {
        Ok(result) => result,
        Err(error) => json!({ "refusal": error }),
    };
    output["initCalls"] = json!(init_calls.get());
    output["depsCalls"] = json!(deps_calls.get());
    Ok(output)
}
