use std::io::{self, BufRead};

use demlik_code_graph::scc::{scc_members, strongly_connected_components};
use demlik_tea::retry_backoff::{BackoffCurve, Jitter, as_rng, backoff_delay};
use serde::Deserialize;
use serde_json::{Value, json};
mod core;
mod retry;

#[derive(Deserialize)]
struct Case {
    id: String,
    operation: String,
    input: Value,
}

#[derive(Clone, Copy, Deserialize)]
enum SpecialNumber {
    NaN,
    Infinity,
    #[serde(rename = "-Infinity")]
    NegativeInfinity,
    #[serde(rename = "-0")]
    NegativeZero,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(untagged)]
enum Number {
    Finite(f64),
    Special {
        #[serde(rename = "$number")]
        value: SpecialNumber,
    },
}

impl Number {
    fn value(self) -> f64 {
        match self {
            Self::Finite(value) => value,
            Self::Special {
                value: SpecialNumber::NaN,
            } => f64::NAN,
            Self::Special {
                value: SpecialNumber::Infinity,
            } => f64::INFINITY,
            Self::Special {
                value: SpecialNumber::NegativeInfinity,
            } => f64::NEG_INFINITY,
            Self::Special {
                value: SpecialNumber::NegativeZero,
            } => -0.0,
        }
    }
}

fn encode_number(value: f64) -> Value {
    if value.is_nan() {
        json!({ "$number": "NaN" })
    } else if value == f64::INFINITY {
        json!({ "$number": "Infinity" })
    } else if value == f64::NEG_INFINITY {
        json!({ "$number": "-Infinity" })
    } else if value == 0.0 && value.is_sign_negative() {
        json!({ "$number": "-0" })
    } else {
        json!(value)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurveInput {
    base_ms: Number,
    factor: Number,
    cap_ms: Number,
    jitter: Jitter,
}

#[derive(Deserialize)]
struct BackoffInput {
    attempt: Number,
    curve: CurveInput,
    random: Vec<Number>,
}

#[derive(Deserialize)]
struct GraphInput {
    nodes: Vec<String>,
    adjacency: std::collections::HashMap<String, Vec<String>>,
}

fn execute(case: &Case) -> Result<Value, String> {
    match case.operation.as_str() {
        "tea.core.machine" => core::execute(case.input.clone()),
        "tea.retry.state" => retry::state(case.input.clone()),
        "tea.retry.probe" => retry::probe(case.input.clone()),
        "tea.retry.backoff" => {
            let input: BackoffInput =
                serde_json::from_value(case.input.clone()).map_err(|error| error.to_string())?;
            let curve = BackoffCurve {
                base_ms: input.curve.base_ms.value(),
                factor: input.curve.factor.value(),
                cap_ms: input.curve.cap_ms.value(),
                jitter: input.curve.jitter,
            };
            let mut consumed = 0;
            let mut exhausted = false;
            let value = {
                let mut rng = as_rng(
                    || {
                        let value = input.random.get(consumed).copied();
                        consumed += 1;
                        match value {
                            Some(value) => value.value(),
                            None => {
                                exhausted = true;
                                f64::NAN
                            }
                        }
                    },
                    false,
                )
                .map_err(|error| error.to_string())?;
                backoff_delay(input.attempt.value(), &curve, &mut rng)
            };
            if exhausted {
                return Err("recorded random draws exhausted".into());
            }
            Ok(json!({ "value": encode_number(value), "randomDraws": consumed }))
        }
        "code_graph.scc" | "code_graph.scc_members" => {
            let input: GraphInput =
                serde_json::from_value(case.input.clone()).map_err(|error| error.to_string())?;
            let components = strongly_connected_components(&input.nodes, &input.adjacency);
            if case.operation == "code_graph.scc_members" {
                let members = scc_members(&input.nodes, &components)
                    .into_iter()
                    .collect::<Vec<_>>();
                Ok(json!({ "members": members }))
            } else {
                Ok(json!({ "components": components.into_iter().collect::<Vec<_>>() }))
            }
        }
        operation => Err(format!("unsupported operation: {operation}")),
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let case: Case = serde_json::from_str(&line?)?;
        let response = match execute(&case) {
            Ok(output) => json!({ "id": case.id, "ok": true, "output": output }),
            Err(message) => {
                json!({ "id": case.id, "ok": false, "error": { "kind": "driver_error", "message": message } })
            }
        };
        println!("{}", serde_json::to_string(&response)?);
    }
    Ok(())
}
