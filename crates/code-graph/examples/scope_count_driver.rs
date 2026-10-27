use demlik_code_graph::{
    ratchet::scope_count::{
        self, CeilingDirection, CeilingValue, ScopeCeilingsResolution, ScopeCount,
        ScopeCountCeilings, ScopeCountInputError, ScopeCountVerdict, ScopeCountViolation,
    },
    text::{JsObject, JsString, JsValue, has_object_prototype_property, object_keys},
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::io::{self, BufRead};
#[path = "support/number_input.rs"]
mod number_input;
use number_input::JsNumberInput;
macro_rules! observe {($calls:expr,$function:path $(,$argument:expr)* $(,)?)=>{{let returned=$function($($argument),*);$calls.push(stringify!($function));returned}};}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Measurement {
    scope: JsString,
    count: JsNumberInput,
}
impl From<Measurement> for ScopeCount {
    fn from(value: Measurement) -> Self {
        Self {
            scope: value.scope,
            count: value.count.value(),
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ceilings {
    default: JsNumberInput,
    scopes: Vec<(JsString, JsNumberInput)>,
}
impl From<Ceilings> for ScopeCountCeilings {
    fn from(value: Ceilings) -> Self {
        Self {
            default: value.default.value(),
            scopes: value
                .scopes
                .into_iter()
                .map(|(key, number)| (key, number.value()))
                .collect(),
        }
    }
}
enum Ceiling {
    Number { value: JsNumberInput },
    Inherited { scope: JsString },
}
impl<'de> Deserialize<'de> for Ceiling {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        let value = JsValue::parse(raw.get()).map_err(serde::de::Error::custom)?;
        let checked = (|| -> Result<Self, String> {
            let kind: String = decode(field(&value, "kind")?)?;
            match kind.as_str() {
                "number" => {
                    fields(&value, &["kind", "value"])?;
                    Ok(Self::Number {
                        value: decode(field(&value, "value")?)?,
                    })
                }
                "inherited" => {
                    fields(&value, &["kind", "scope"])?;
                    Ok(Self::Inherited {
                        scope: decode(field(&value, "scope")?)?,
                    })
                }
                _ => Err("unknown ceiling kind".into()),
            }
        })();
        checked.map_err(serde::de::Error::custom)
    }
}
impl Ceiling {
    fn value(self) -> Result<CeilingValue, String> {
        match self {
            Self::Number { value } => Ok(CeilingValue::Number(value.value())),
            Self::Inherited { scope } => {
                if !has_object_prototype_property(&scope) {
                    return Err("expected an Object.prototype property".into());
                }
                Ok(ScopeCountCeilings::default().ceiling_of(&scope))
            }
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Violation {
    scope: JsString,
    measured: JsNumberInput,
    ceiling: Ceiling,
    direction: CeilingDirection,
    delta: JsNumberInput,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Verdict {
    passed: bool,
    scopes_checked: JsNumberInput,
    violations: Vec<Violation>,
}
impl Verdict {
    fn value(self) -> Result<ScopeCountVerdict, String> {
        Ok(ScopeCountVerdict {
            passed: self.passed,
            scopes_checked: self.scopes_checked.value(),
            violations: self
                .violations
                .into_iter()
                .map(|row| {
                    Ok(ScopeCountViolation {
                        scope: row.scope,
                        measured: row.measured.value(),
                        ceiling: row.ceiling.value()?,
                        direction: row.direction,
                        delta: row.delta.value(),
                    })
                })
                .collect::<Result<_, String>>()?,
        })
    }
}
enum Input {
    Parse {
        value: JsValue,
    },
    ParseNumbers {
        ceilings: Ceilings,
    },
    Evaluate {
        measurements: Vec<Measurement>,
        ceilings: Ceilings,
        title: JsString,
    },
    Table {
        verdict: Verdict,
        title: JsString,
    },
    Paths {
        repo_root: JsString,
        absolute: JsString,
        scopes: Vec<JsString>,
        under: JsString,
    },
    Read {
        file: JsString,
    },
}
fn field<'a>(value: &'a JsValue, name: &str) -> Result<&'a JsValue, String> {
    value
        .get(name)
        .ok_or_else(|| format!("missing field {name}"))
}
fn decode<T: serde::de::DeserializeOwned>(value: &JsValue) -> Result<T, String> {
    serde_json::from_str(&serde_json::to_string(value).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}
fn fields(value: &JsValue, names: &[&str]) -> Result<(), String> {
    let object = value.as_object().ok_or("expected object")?;
    if object.len() != names.len()
        || names
            .iter()
            .any(|name| !object.contains_key(&JsString::from(*name)))
    {
        return Err("unexpected or missing input field".into());
    }
    Ok(())
}
fn input(raw: &str) -> Result<Input, String> {
    let value = JsValue::parse(raw).map_err(|error| error.to_string())?;
    let action: String = decode(field(&value, "action")?)?;
    match action.as_str() {
        "parse" => {
            fields(&value, &["action", "value"])?;
            Ok(Input::Parse {
                value: field(&value, "value")?.clone(),
            })
        }
        "parse-numbers" => {
            fields(&value, &["action", "ceilings"])?;
            Ok(Input::ParseNumbers {
                ceilings: decode(field(&value, "ceilings")?)?,
            })
        }
        "evaluate" => {
            fields(&value, &["action", "measurements", "ceilings", "title"])?;
            Ok(Input::Evaluate {
                measurements: decode(field(&value, "measurements")?)?,
                ceilings: decode(field(&value, "ceilings")?)?,
                title: decode(field(&value, "title")?)?,
            })
        }
        "table" => {
            fields(&value, &["action", "verdict", "title"])?;
            Ok(Input::Table {
                verdict: decode(field(&value, "verdict")?)?,
                title: decode(field(&value, "title")?)?,
            })
        }
        "paths" => {
            fields(
                &value,
                &["action", "repoRoot", "absolute", "scopes", "under"],
            )?;
            Ok(Input::Paths {
                repo_root: decode(field(&value, "repoRoot")?)?,
                absolute: decode(field(&value, "absolute")?)?,
                scopes: decode(field(&value, "scopes")?)?,
                under: decode(field(&value, "under")?)?,
            })
        }
        "read" => {
            fields(&value, &["action", "file"])?;
            Ok(Input::Read {
                file: decode(field(&value, "file")?)?,
            })
        }
        _ => Err("unknown action".into()),
    }
}
fn output(value: &impl Serialize) -> Result<Box<RawValue>, String> {
    RawValue::from_string(serde_json::to_string(value).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NumberFacts {
    negative_zero: bool,
    nonfinite: Option<&'static str>,
}
fn number_facts(number: f64) -> NumberFacts {
    NumberFacts {
        negative_zero: number == 0.0 && number.is_sign_negative(),
        nonfinite: if number.is_nan() {
            Some("NaN")
        } else if number == f64::INFINITY {
            Some("Infinity")
        } else if number == f64::NEG_INFINITY {
            Some("-Infinity")
        } else {
            None
        },
    }
}
#[derive(Serialize)]
struct CeilingFacts {
    default: NumberFacts,
    scopes: Vec<(JsString, NumberFacts)>,
}
fn ceiling_facts(ceilings: &ScopeCountCeilings) -> CeilingFacts {
    CeilingFacts {
        default: number_facts(ceilings.default),
        scopes: object_keys(&ceilings.scopes)
            .into_iter()
            .map(|scope| (scope.clone(), number_facts(ceilings.scopes[scope])))
            .collect(),
    }
}
fn schema(value: &JsValue, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, String> {
    #[derive(Serialize)]
    #[serde(untagged)]
    enum Checked {
        Parsed {
            success: bool,
            data: ScopeCountCeilings,
            facts: CeilingFacts,
        },
        Issues {
            success: bool,
            issues: Vec<demlik_code_graph::validation::InputIssue>,
        },
        Thrown {
            thrown: demlik_code_graph::validation::RecordTypeError,
        },
    }
    let checked = match observe!(calls, ScopeCountCeilings::parse, value) {
        Ok(data) => Checked::Parsed {
            success: true,
            facts: ceiling_facts(&data),
            data,
        },
        Err(ScopeCountInputError::Issues(issues)) => Checked::Issues {
            success: false,
            issues,
        },
        Err(ScopeCountInputError::TypeError(thrown)) => Checked::Thrown { thrown },
    };
    output(&checked)
}
fn table(
    verdict: &ScopeCountVerdict,
    title: &JsString,
    calls: &mut Vec<&'static str>,
) -> Result<Box<RawValue>, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Table<'a> {
        verdict: &'a ScopeCountVerdict,
        lines: Vec<JsString>,
        has_exceeded: bool,
        has_slack: bool,
    }
    output(&Table {
        verdict,
        lines: observe!(calls, scope_count::ratchet_table_lines, verdict, title),
        has_exceeded: observe!(
            calls,
            scope_count::has_direction,
            verdict,
            CeilingDirection::Exceeded
        ),
        has_slack: observe!(
            calls,
            scope_count::has_direction,
            verdict,
            CeilingDirection::Slack
        ),
    })
}
fn execute(request: Request, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, String> {
    if request.operation != "code_graph.scope-count" {
        return Err("unsupported operation".into());
    }
    let input = input(request.input.get())?;
    match input {
        Input::Parse { value } => schema(&value, calls),
        Input::ParseNumbers { ceilings } => {
            let ceilings: ScopeCountCeilings = ceilings.into();
            let value = JsValue::Object(JsObject::from([
                ("default".into(), JsValue::Number(ceilings.default)),
                (
                    "scopes".into(),
                    JsValue::Object(
                        ceilings
                            .scopes
                            .into_iter()
                            .map(|(key, value)| (key, JsValue::Number(value)))
                            .collect(),
                    ),
                ),
            ]));
            schema(&value, calls)
        }
        Input::Evaluate {
            measurements,
            ceilings,
            title,
        } => {
            let measurements = measurements
                .into_iter()
                .map(ScopeCount::from)
                .collect::<Vec<_>>();
            let ceilings: ScopeCountCeilings = ceilings.into();
            let verdict = observe!(
                calls,
                scope_count::evaluate_scope_ratchet,
                &measurements,
                &ceilings,
                &demlik_code_graph::project::Collation::try_node22_en_us()
                    .map_err(|error| error.to_string())?
            )
            .map_err(|error| error.to_string())?;
            let recorded = observe!(
                calls,
                scope_count::record_scope_ceilings,
                &measurements,
                &ceilings
            );
            #[derive(Serialize)]
            #[serde(rename_all = "camelCase")]
            struct Evaluation<'a> {
                table: Box<RawValue>,
                recorded: &'a ScopeCountCeilings,
                recorded_facts: CeilingFacts,
                measurements_after: &'a [ScopeCount],
                ceilings_after: &'a ScopeCountCeilings,
            }
            output(&Evaluation {
                table: table(&verdict, &title, calls)?,
                recorded: &recorded,
                recorded_facts: ceiling_facts(&recorded),
                measurements_after: &measurements,
                ceilings_after: &ceilings,
            })
        }
        Input::Table { verdict, title } => table(&verdict.value()?, &title, calls),
        Input::Paths {
            repo_root,
            absolute,
            scopes,
            under,
        } => {
            let scope = observe!(calls, scope_count::scope_of, &repo_root, &absolute)
                .map_err(|error| error.to_string())?;
            let mut selected = observe!(
                calls,
                scope_count::scopes_under,
                &scopes,
                &under,
                &demlik_code_graph::project::Collation::try_node22_en_us()
                    .map_err(|error| error.to_string())?
            )
            .map_err(|error| error.to_string())?;
            let before = scopes.clone();
            let result = selected.clone();
            selected.clear();
            #[derive(Serialize)]
            #[serde(rename_all = "camelCase")]
            struct Paths {
                scope: JsString,
                selected: Vec<JsString>,
                input_after: Vec<JsString>,
                fresh_result: bool,
            }
            output(&Paths {
                scope,
                selected: result,
                fresh_result: before == scopes,
                input_after: scopes,
            })
        }
        Input::Read { file } => {
            #[derive(Serialize)]
            #[serde(untagged)]
            enum Read {
                Value {
                    ceilings: Option<ScopeCountCeilings>,
                    messages: Vec<JsString>,
                },
                Thrown {
                    thrown: demlik_code_graph::validation::RecordTypeError,
                    messages: Vec<JsString>,
                },
            }
            let read = match observe!(calls, scope_count::read_scope_ceilings, &file) {
                Ok(ScopeCeilingsResolution::Resolved(ceilings)) => Read::Value {
                    ceilings: Some(ceilings),
                    messages: vec![],
                },
                Ok(ScopeCeilingsResolution::Refused { message }) => Read::Value {
                    ceilings: None,
                    messages: vec![message],
                },
                Err(thrown) => Read::Thrown {
                    thrown,
                    messages: vec![],
                },
            };
            output(&read)
        }
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let request = serde_json::from_str::<Request>(&line?);
        let id = request.as_ref().ok().map(|request| request.id.clone());
        let mut calls = Vec::new();
        let result = request
            .map_err(|error| error.to_string())
            .and_then(|request| execute(request, &mut calls));
        #[derive(Serialize)]
        struct Error {
            tag: &'static str,
            message: String,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Reply {
            id: Option<String>,
            ok: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            output: Option<Box<RawValue>>,
            #[serde(skip_serializing_if = "Option::is_none")]
            error: Option<Error>,
            observed_calls: Vec<&'static str>,
        }
        let (ok, output, error) = match result {
            Ok(value) => (true, Some(value), None),
            Err(message) => (
                false,
                None,
                Some(Error {
                    tag: "driver-error",
                    message,
                }),
            ),
        };
        println!(
            "{}",
            serde_json::to_string(&Reply {
                id,
                ok,
                output,
                error,
                observed_calls: calls
            })?
        );
    }
    Ok(())
}
