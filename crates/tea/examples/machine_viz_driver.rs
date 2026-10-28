use demlik_tea::{
    Machine, Step, Tagged, TryUpdate,
    core::{Row, SubEntry, SubscriptionEntries},
    data::{JsText, PlainData, stringify_json},
    machine_viz::{self, Direction, MachineVizOptions, Samples},
};
use indexmap::IndexMap;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    io::{self, BufRead},
    panic::{AssertUnwindSafe, catch_unwind},
    rc::Rc,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Fixture {
    id: String,
    kind: Kind,
    #[serde(default)]
    texts: Vec<JsText>,
    #[serde(default)]
    form: Form,
    #[serde(default)]
    rows: Vec<(String, Vec<(String, String)>)>,
    #[serde(default)]
    states: Vec<(String, String)>,
    #[serde(default)]
    messages: Vec<(String, String)>,
    #[serde(default)]
    subs: Vec<SubSpec>,
    #[serde(default)]
    ctx: bool,
    #[serde(default)]
    title: Option<JsText>,
    #[serde(default)]
    direction: Option<Layout>,
    #[serde(default)]
    throw_cell: Option<String>,
    #[serde(default)]
    throw_init: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SubSpec {
    name: String,
    active: Vec<String>,
    #[serde(default, rename = "throw")]
    fail: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Sanitize,
    Diagram,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Form {
    #[default]
    Transitions,
    Reducer,
}
#[derive(Deserialize)]
enum Layout {
    TB,
    LR,
}
struct State(String);
impl Tagged for State {
    fn tag(&self) -> &str {
        &self.0
    }
}
struct Msg(String);
type Calls = Rc<RefCell<Vec<Value>>>;

fn plain(value: Value) -> PlainData {
    PlainData::from(&value)
}
fn output(input: &Fixture) -> PlainData {
    if matches!(input.kind, Kind::Sanitize) {
        let values = input
            .texts
            .iter()
            .map(|text| {
                PlainData::Object(
                    [
                        (
                            "id".into(),
                            PlainData::String(machine_viz::safe_id(text).into()),
                        ),
                        (
                            "label".into(),
                            PlainData::String(machine_viz::safe_label(text)),
                        ),
                    ]
                    .into_iter()
                    .collect(),
                )
            })
            .collect();
        return PlainData::Object(
            [
                ("output".into(), PlainData::Array(values)),
                ("calls".into(), PlainData::Array(vec![])),
            ]
            .into_iter()
            .collect(),
        );
    }
    let calls: Calls = Rc::new(RefCell::new(vec![]));
    let mut rows = IndexMap::new();
    for (state, specs) in &input.rows {
        let mut row: Row<'_, State, Msg, ()> = IndexMap::new();
        for (message, target) in specs {
            let calls = Rc::clone(&calls);
            let failure = input.throw_cell.as_deref() == Some(&format!("{state}.{message}"));
            row.insert(
                message.clone(),
                Box::new(move |s, m| {
                    calls
                        .borrow_mut()
                        .push(json!(["cell", state, message, s.0, m.0]));
                    assert!(!failure, "cell refused");
                    Step::new(State(target.clone()), vec![])
                }),
            );
        }
        rows.insert(state.clone(), row);
    }
    let update = if matches!(input.form, Form::Reducer) {
        TryUpdate::raw_reducer(
            input
                .rows
                .iter()
                .map(|(name, _)| {
                    (
                        name.clone(),
                        Box::new(|_: &State, _: &Msg| -> Step<State, ()> {
                            panic!("a reducer cell must not be executed")
                        }) as _,
                    )
                })
                .collect(),
        )
    } else {
        TryUpdate::raw_transitions(rows)
    };
    let entries = input
        .subs
        .iter()
        .enumerate()
        .map(|(index, spec)| {
            let calls = Rc::clone(&calls);
            SubEntry::try_new(spec.name.clone(), move |state: &State| {
                calls.borrow_mut().push(json!(["deps", index, state.0]));
                if spec.fail {
                    return Err("deps refused");
                }
                Ok(spec.active.contains(&state.0).then_some(true))
            })
        })
        .collect();
    let init_calls = Rc::clone(&calls);
    let machine = Machine {
        init: Box::new(move |_, _: &()| {
            init_calls.borrow_mut().push(json!(["init"]));
            assert!(!input.throw_init, "init refused");
            Step::new(
                State(input.rows.first().map_or("fresh", |(name, _)| name).into()),
                vec![],
            )
        }),
        update,
        subscriptions: Box::new(SubscriptionEntries::new(entries)),
    };
    let states: Vec<_> = input
        .states
        .iter()
        .map(|(key, tag)| (key, State(tag.clone())))
        .collect();
    let messages: Vec<_> = input
        .messages
        .iter()
        .map(|(key, tag)| (key, Msg(tag.clone())))
        .collect();
    let options = MachineVizOptions {
        direction: match input.direction {
            None | Some(Layout::TB) => Direction::TB,
            Some(Layout::LR) => Direction::LR,
        },
        title: input.title.as_ref(),
        samples: Samples {
            states: states
                .iter()
                .map(|(key, state)| ((*key).clone(), state))
                .collect(),
            messages: messages
                .iter()
                .map(|(key, message)| ((*key).clone(), message))
                .collect(),
            context: input.ctx.then_some(&()),
        },
    };
    let result = catch_unwind(AssertUnwindSafe(|| {
        machine_viz::to_mermaid(&machine, options)
    }));
    let mut comparison: IndexMap<JsText, PlainData> = IndexMap::new();
    match result {
        Ok(Ok(text)) => {
            comparison.insert("output".into(), PlainData::String(text));
        }
        Ok(Err(demlik_tea::core::ProjectionError::Declared(error))) => {
            comparison.insert("error".into(), PlainData::String(error.into()));
        }
        Ok(Err(_)) => panic!("unexpected subscription projection failure"),
        Err(payload) => {
            comparison.insert(
                "error".into(),
                PlainData::String(
                    payload
                        .downcast_ref::<String>()
                        .map(String::as_str)
                        .or_else(|| payload.downcast_ref::<&str>().copied())
                        .unwrap_or("unknown panic")
                        .into(),
                ),
            );
        }
    }
    comparison.insert("calls".into(), plain(json!(*calls.borrow())));
    PlainData::Object(comparison)
}
fn main() {
    for line in io::stdin().lock().lines() {
        let frame = match line {
            Ok(line) => match serde_json::from_str::<Fixture>(&line) {
                Ok(input) => PlainData::Object(
                    [
                        ("id".into(), PlainData::String(input.id.clone().into())),
                        ("comparison".into(), output(&input)),
                    ]
                    .into_iter()
                    .collect(),
                ),
                Err(error) => plain(json!({"error":error.to_string()})),
            },
            Err(error) => plain(json!({"error":error.to_string()})),
        };
        let rendered = stringify_json(&frame).expect("object is not undefined");
        println!("{rendered}");
    }
}
