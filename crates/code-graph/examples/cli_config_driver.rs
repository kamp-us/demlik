use demlik_code_graph::{
    config::{ConfigResolution, NodeKindConfigError},
    kinds::rules::{NodeKindRules, RuleInputError},
    text::{JsString, JsValue},
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::io::{self, BufRead};
macro_rules! observe {($calls:expr,$function:path $(,$argument:expr)* $(,)?)=>{{let returned=$function($($argument),*);$calls.push(stringify!($function));returned}};}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Kind {
    Thresholds,
    Collapse,
    Rules,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SchemaInput {
    action: String,
    kind: Kind,
    json: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolveInput {
    action: String,
    kind: Kind,
    file: Option<JsString>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PresetInput {
    action: String,
    json: String,
    names: Vec<JsString>,
}
fn object<const N: usize>(fields: [(&str, JsValue); N]) -> JsValue {
    JsValue::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}
fn json(value: &impl Serialize) -> Result<JsValue, String> {
    JsValue::parse(&serde_json::to_string(value).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}
fn resolved<T: Serialize>(value: ConfigResolution<T>) -> Result<JsValue, String> {
    Ok(match value {
        ConfigResolution::Resolved(value) => object([
            ("value", json(&value)?),
            ("reports", JsValue::Array(Vec::new())),
        ]),
        ConfigResolution::Refused { message } => object([
            ("value", JsValue::Null),
            ("reports", JsValue::Array(vec![JsValue::String(message)])),
        ]),
    })
}
fn thrown(error: NodeKindConfigError) -> JsValue {
    let (name, message) = match error {
        NodeKindConfigError::Rules(RuleInputError::TypeError(message)) => ("TypeError", message),
        NodeKindConfigError::Rules(RuleInputError::Issue(issue)) => {
            ("Error", issue.to_string().into())
        }
        NodeKindConfigError::Glob(error) => ("SyntaxError", error.to_string().into()),
    };
    object([(
        "thrown",
        object([
            ("name", JsValue::String(name.into())),
            ("message", JsValue::String(message)),
        ]),
    )])
}
fn schema<T: Serialize>(
    result: Result<T, demlik_code_graph::validation::InputIssue>,
) -> Result<JsValue, String> {
    Ok(match result {
        Ok(value) => object([("success", JsValue::Bool(true)), ("data", json(&value)?)]),
        Err(issue) => object([("success", JsValue::Bool(false)), ("issue", json(&issue)?)]),
    })
}
fn execute(request: Request, calls: &mut Vec<&'static str>) -> Result<JsValue, String> {
    if request.operation != "code_graph.cli-config" {
        return Err("unknown operation".into());
    }
    let input = JsValue::parse(request.input.get()).map_err(|error| error.to_string())?;
    let action = input
        .get("action")
        .and_then(JsValue::as_string)
        .ok_or("missing string action")?
        .to_utf8()
        .map_err(|error| error.to_string())?;
    match action.as_str() {
        "schema" => {
            let SchemaInput {
                action,
                kind,
                json: raw,
            } = serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            assert_eq!(action, "schema");
            let value = JsValue::parse(&raw).map_err(|error| error.to_string())?;
            match kind {
                Kind::Thresholds => schema(observe!(
                    calls,
                    demlik_code_graph::schema::Thresholds::parse,
                    &value
                )),
                Kind::Collapse => {
                    let result = observe!(
                        calls,
                        demlik_code_graph::collapse::settings::CollapseSettings::parse,
                        &value
                    );
                    let zeroes = result.as_ref().ok().map(|settings| {
                        let JsValue::Object(fields) = settings.as_value() else {
                            unreachable!()
                        };
                        fields
                            .into_iter()
                            .filter_map(|(key, value)| match value {
                                JsValue::Number(number)
                                    if number == 0.0 && number.is_sign_negative() =>
                                {
                                    Some(JsValue::String(key))
                                }
                                _ => None,
                            })
                            .collect()
                    });
                    let mut output = schema(result)?;
                    if let (JsValue::Object(fields), Some(zeroes)) = (&mut output, zeroes) {
                        fields.insert("negativeZeroFields".into(), JsValue::Array(zeroes));
                    }
                    Ok(output)
                }
                Kind::Rules => Err("rules schema is outside this driver action".into()),
            }
        }
        "resolve" => {
            let ResolveInput { action, kind, file } =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            assert_eq!(action, "resolve");
            match kind {
                Kind::Thresholds => resolved(observe!(
                    calls,
                    demlik_code_graph::config::resolve_thresholds,
                    file.as_ref()
                )),
                Kind::Collapse => resolved(observe!(
                    calls,
                    demlik_code_graph::config::resolve_collapse_settings,
                    file.as_ref()
                )),
                Kind::Rules => match observe!(
                    calls,
                    demlik_code_graph::config::resolve_node_kind_rules,
                    file.as_ref()
                ) {
                    Ok(value) => match value {
                        ConfigResolution::Resolved(rules) => {
                            resolved(ConfigResolution::Resolved(rules.as_value()))
                        }
                        ConfigResolution::Refused { message } => {
                            resolved::<JsValue>(ConfigResolution::Refused { message })
                        }
                    },
                    Err(error) => Ok(thrown(error)),
                },
            }
        }
        "presets" => {
            let PresetInput {
                action,
                json: raw,
                names,
            } = serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            assert_eq!(action, "presets");
            let value = JsValue::parse(&raw).map_err(|error| error.to_string())?;
            let rules = NodeKindRules::parse(&value).map_err(|error| error.to_string())?;
            let group = rules
                .entry_names
                .values()
                .next()
                .map(|group| group.as_ptr());
            let result = observe!(
                calls,
                demlik_code_graph::config::with_entry_presets,
                rules,
                &names
            );
            match result {
                ConfigResolution::Resolved(rules) => Ok(object([
                    ("value", rules.as_value()),
                    ("reports", JsValue::Array(Vec::new())),
                    (
                        "unchangedGroupStorage",
                        JsValue::Bool(
                            rules
                                .entry_names
                                .values()
                                .next()
                                .map(|group| group.as_ptr())
                                == group,
                        ),
                    ),
                ])),
                ConfigResolution::Refused { message } => Ok(object([
                    ("value", JsValue::Null),
                    ("reports", JsValue::Array(vec![JsValue::String(message)])),
                ])),
            }
        }
        _ => Err("unknown action".into()),
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
        struct DriverError {
            tag: &'static str,
            message: String,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Reply {
            id: Option<String>,
            ok: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            output: Option<JsValue>,
            #[serde(skip_serializing_if = "Option::is_none")]
            error: Option<DriverError>,
            observed_calls: Vec<&'static str>,
        }
        let (output, error) = match result {
            Ok(value) => (Some(value), None),
            Err(message) => (
                None,
                Some(DriverError {
                    tag: "driver-error",
                    message,
                }),
            ),
        };
        println!(
            "{}",
            serde_json::to_string(&Reply {
                id,
                ok: output.is_some(),
                output,
                error,
                observed_calls: calls
            })?
        );
    }
    Ok(())
}
