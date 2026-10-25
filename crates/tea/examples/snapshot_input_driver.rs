use demlik_tea::{
    PlainData,
    data::{NumberOrNull, plain_data},
    persistence::snapshot::{SnapshotConfig, SnapshotState, SnapshotWriteInput, create_snapshot},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::{self, BufRead},
    rc::Rc,
};
#[derive(Deserialize)]
#[serde(untagged)]
enum Number {
    Finite(f64),
    Special {
        #[serde(rename = "$number")]
        value: String,
    },
}
impl Number {
    fn value(&self) -> f64 {
        match self {
            Self::Finite(v) => *v,
            Self::Special { value } => match value.as_str() {
                "NaN" => f64::NAN,
                "Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                "-0" => -0.0,
                _ => panic!("invalid number"),
            },
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Script {
    seq: Number,
    at: Number,
    round_trip: bool,
    last_saved_seq: Option<Number>,
    last_saved_at: Option<Number>,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    input: Script,
}
fn number(value: f64) -> Value {
    if value.is_nan() {
        json!({"$number":"NaN"})
    } else if value == f64::INFINITY {
        json!({"$number":"Infinity"})
    } else if value == f64::NEG_INFINITY {
        json!({"$number":"-Infinity"})
    } else if value == 0.0 && value.is_sign_negative() {
        json!({"$number":"-0"})
    } else {
        json!(value)
    }
}
fn optional(value: Option<f64>) -> Value {
    value.map_or(Value::Null, number)
}
fn normalized(value: NumberOrNull) -> Value {
    optional(value.number())
}
macro_rules! observe {($calls:expr,$function:path $(,$arg:expr)* $(,)?)=>{{let value=$function($($arg),*);$calls.push(stringify!($function));value}};}
fn execute(case: Case) -> Value {
    let mut calls = vec![];
    let script = case.input;
    let snapshot = observe!(
        calls,
        create_snapshot::<PlainData>,
        SnapshotConfig {
            every: 1.0,
            key: None
        }
    );
    let mut input = observe!(
        calls,
        SnapshotWriteInput::new,
        "snapshot",
        script.seq.value(),
        script.at.value(),
        Rc::new(PlainData::Null)
    );
    if script.round_trip {
        input = serde_json::from_str(&serde_json::to_string(&input).unwrap()).unwrap();
    }
    let input_data = json!({"key":"snapshot","seq":normalized(input.seq),"at":normalized(input.at),"payload":null});
    let command = observe!(
        calls,
        demlik_tea::command::CmdDef::from_record,
        &snapshot.write,
        input
    );
    let wire = serde_json::to_string(&command).unwrap();
    let msg = observe!(
        calls,
        demlik_tea::command::CmdDef::ok,
        &snapshot.write,
        command,
        PlainData::Undefined,
        Some(1.0)
    );
    let state = Rc::new(SnapshotState {
        last_saved_seq: script.last_saved_seq.as_ref().map(Number::value),
        last_saved_at: script.last_saved_at.as_ref().map(Number::value),
        ..*snapshot.init()
    });
    let step = observe!(
        calls,
        demlik_tea::persistence::snapshot::Snapshot::confirm,
        &snapshot,
        &state,
        &msg
    );
    let output = json!({"input":input_data,"wire":wire,"sameState":Rc::ptr_eq(&state,&step.state),"state":{"sinceLast":normalized(step.state.since_last),"seq":normalized(step.state.seq),"lastSavedSeq":optional(step.state.last_saved_seq),"lastSavedAt":optional(step.state.last_saved_at)},"commands":step.commands.len()});
    assert!(plain_data(&msg).is_ok());
    json!({"id":case.id,"comparison":output,"observedRustCalls":calls})
}
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let case: Case = serde_json::from_str(&line).unwrap();
        println!("{}", execute(case));
    }
}
