use demlik_tea::{
    PlainData,
    agent::{
        AgentStatus, AgentTerminalFailure, status,
        types::{AgentEndedStatus, AgentField, AgentNumber, AgentState},
    },
    data::{JsText, plain_data, stringify_json},
    flow::monitored_run::RunPhase,
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    io::{self, BufRead},
    rc::Rc,
};
macro_rules! observe {
    ($calls:expr,$function:path,$arg:expr) => {{
        let value = $function($arg);
        $calls.push(stringify!($function));
        value
    }};
}
type State = AgentState<PlainData, JsText, PlainData, PlainData>;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Frame {
    id: String,
    input: Input,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    state: Box<RawValue>,
    #[serde(default)]
    undefined: Vec<Undefined>,
    at: Option<At>,
    #[serde(default)]
    cold: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Undefined {
    Failure,
    Output,
    Usage,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum At {
    Nan,
    Infinity,
    NegativeInfinity,
    NegativeZero,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    wire: String,
    kind: &'static str,
    failure_own: bool,
    failure_presence: &'static str,
    failure_is_agent: bool,
    failure_is_run: bool,
    output_own: bool,
    output_presence: &'static str,
    output_same: bool,
    usage_same: bool,
    shared_no_usage: bool,
    pending_same: bool,
    pending_repeat_same: bool,
    at_presence: &'static str,
    run_phase: String,
    observed_calls: Vec<&'static str>,
}
fn number(value: AgentNumber) -> &'static str {
    match value.number() {
        None => "null",
        Some(v) if v == 0.0 && v.is_sign_negative() => "-0",
        Some(v) if v.is_nan() => "NaN",
        Some(v) if v == f64::INFINITY => "+Infinity",
        Some(v) if v == f64::NEG_INFINITY => "-Infinity",
        Some(_) => "number",
    }
}
fn execute(input: Input) -> Result<Observation, String> {
    let mut state: State = serde_json::from_str(input.state.get()).map_err(|e| e.to_string())?;
    for name in input.undefined {
        match name {
            Undefined::Failure => state.failure = AgentField::Undefined,
            Undefined::Output => state.output = AgentField::Undefined,
            Undefined::Usage => state.usage = AgentField::Undefined,
        }
    }
    if let Some(at) = input.at {
        let mut run = state.run.as_ref().clone();
        let RunPhase::Cancelled { at: stamp, .. } = &mut run.phase else {
            return Err("timestamp marker needs cancelled state".into());
        };
        *stamp = match at {
            At::Nan => f64::NAN,
            At::Infinity => f64::INFINITY,
            At::NegativeInfinity => f64::NEG_INFINITY,
            At::NegativeZero => -0.0,
        }
        .into();
        state.run = Rc::new(run);
    }
    if input.cold {
        let data = plain_data(&state).map_err(|e| e.to_string())?;
        state = serde_json::from_str(&stringify_json(&data).ok_or("missing JSON")?)
            .map_err(|e| e.to_string())?;
    }
    let mut calls = vec![];
    let projected = observe!(&mut calls, demlik_tea::agent::status, &state);
    let again = status(&state);
    let wire = stringify_json(&plain_data(&projected).map_err(|e| e.to_string())?)
        .ok_or("missing status JSON")?;
    let mut out = Observation {
        wire,
        kind: "running",
        failure_own: false,
        failure_presence: "undefined",
        failure_is_agent: false,
        failure_is_run: false,
        output_own: false,
        output_presence: "undefined",
        output_same: false,
        usage_same: false,
        shared_no_usage: false,
        pending_same: false,
        pending_repeat_same: false,
        at_presence: "undefined",
        run_phase: state.run.phase.as_str().into(),
        observed_calls: calls,
    };
    match projected {
        AgentStatus::Idle => out.kind = "idle",
        AgentStatus::Running => {}
        AgentStatus::Suspended { pending } => {
            out.kind = "suspended";
            out.pending_same = std::ptr::eq(pending, &state.tools.running);
            out.pending_repeat_same =
                matches!(again,AgentStatus::Suspended{pending:other}if std::ptr::eq(pending,other));
        }
        AgentStatus::Ended(AgentEndedStatus::Cancelled { at }) => {
            out.kind = "cancelled";
            out.at_presence = number(at);
        }
        AgentStatus::Ended(AgentEndedStatus::Failed { failure }) => {
            out.kind = "failed";
            out.failure_own = !failure.is_absent();
            out.failure_presence = match failure {
                AgentField::Absent => "absent",
                AgentField::Undefined => {
                    out.failure_is_agent =
                        matches!(state.failure, AgentField::Absent | AgentField::Undefined);
                    "undefined"
                }
                AgentField::Value(carrier) => {
                    match carrier.as_ref() {
                        AgentTerminalFailure::Agent(value) => {
                            out.failure_is_agent = matches!(&state.failure,AgentField::Value(Some(original))if Rc::ptr_eq(value,original));
                        }
                        AgentTerminalFailure::Run(value) => {
                            out.failure_is_run = matches!(&state.run.phase,RunPhase::Failed{failure,..}if Rc::ptr_eq(value,failure));
                        }
                    }
                    "object"
                }
            };
        }
        AgentStatus::Ended(AgentEndedStatus::Done { output, usage }) => {
            out.kind = "done";
            out.output_own = !output.is_absent();
            out.output_presence = match &output {
                AgentField::Absent => "absent",
                AgentField::Undefined => "undefined",
                AgentField::Value(None) => "null",
                AgentField::Value(Some(_)) => "object",
            };
            out.output_same = match (&output, &state.output) {
                (AgentField::Undefined, AgentField::Absent | AgentField::Undefined)
                | (AgentField::Value(None), AgentField::Value(None)) => true,
                (AgentField::Value(Some(a)), AgentField::Value(Some(b))) => Rc::ptr_eq(a, b),
                _ => false,
            };
            out.usage_same = matches!(&state.usage,AgentField::Value(Some(original))if Rc::ptr_eq(&usage,original));
            let mut fallback = state.clone();
            fallback.failure = AgentField::Value(None);
            fallback.usage = AgentField::Undefined;
            let mut run = fallback.run.as_ref().clone();
            run.phase = RunPhase::Done {
                run_id: "fallback".into(),
            };
            fallback.run = Rc::new(run);
            let AgentStatus::Ended(AgentEndedStatus::Done { usage: zero, .. }) = status(&fallback)
            else {
                unreachable!()
            };
            out.shared_no_usage = Rc::ptr_eq(&usage, &zero);
        }
    }
    Ok(out)
}
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        let parsed = serde_json::from_str::<Frame>(&line);
        let result = match parsed {
            Ok(frame) => {
                let id = frame.id;
                match execute(frame.input) {
                    Ok(output) => serde_json::json!({"id":id,"ok":true,"output":output}),
                    Err(error) => {
                        serde_json::json!({"id":id,"ok":false,"error":error,"observedCalls":[]})
                    }
                }
            }
            Err(error) => {
                let id = serde_json::from_str::<serde_json::Value>(&line)
                    .ok()
                    .and_then(|v| v.get("id").cloned());
                serde_json::json!({"id":id,"ok":false,"error":error.to_string(),"observedCalls":[]})
            }
        };
        println!("{result}");
    }
}
