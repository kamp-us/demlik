#[path = "agent_model/runtime.rs"]
mod model_runtime;
#[path = "agent_model/scenario.rs"]
mod scenario;
use demlik_tea::{
    PlainData,
    data::{JsText, JsonData},
};
use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    cell::RefCell,
    io::{self, BufRead, Write},
    rc::Rc,
};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: JsText,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: Option<JsText>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    observed_calls: Vec<&'static str>,
}
async fn execute(request: Request, calls: &scenario::Calls) -> Result<PlainData, String> {
    match request.operation.as_str() {
        "input-boundary" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Input {
                variant: String,
            }
            let input: Input =
                serde_json::from_str(request.input.get()).map_err(|e| e.to_string())?;
            if !matches!(input.variant.as_str(), "missing" | "undefined") {
                return Err("unknown input variant".into());
            }
            Ok(scenario::input_boundary(&input.variant, calls).await)
        }
        "vocabulary" => {
            let input: serde_json::Value =
                serde_json::from_str(request.input.get()).map_err(|e| e.to_string())?;
            if input.as_object().is_none_or(|value| !value.is_empty()) {
                return Err("expected empty input".into());
            }
            calls
                .borrow_mut()
                .push("demlik_tea::agent::model::PLAIN_MODEL_MISROUTE_REASON");
            Ok(scenario::object([(
                "reason",
                scenario::string(demlik_tea::agent::model::PLAIN_MODEL_MISROUTE_REASON),
            )]))
        }
        "scenario" => {
            let script: scenario::Script =
                serde_json::from_str(request.input.get()).map_err(|e| e.to_string())?;
            if script.repeats == 0 || script.repeats > 3 {
                return Err("repeats must be1..3".into());
            }
            Ok(scenario::run(script, calls).await)
        }
        "runtime-promise" | "runtime-effect" => {
            let script: scenario::Script =
                serde_json::from_str(request.input.get()).map_err(|e| e.to_string())?;
            if script.repeats != 1 {
                return Err("runtime accepts one call".into());
            }
            let profile = if request.operation == "runtime-promise" {
                demlik_tea::runtime::Profile::Promise
            } else {
                demlik_tea::runtime::Profile::Effect
            };
            Ok(model_runtime::run(script, profile, calls).await)
        }
        _ => Err("unknown operation".into()),
    }
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tokio::task::LocalSet::new()
        .run_until(async {
            let input = io::stdin();
            let mut stdout = io::BufWriter::new(io::stdout());
            for line in input.lock().lines() {
                let line = line?;
                let request = serde_json::from_str::<Request>(&line);
                let id = request.as_ref().ok().map(|r| r.id.clone());
                let calls = Rc::new(RefCell::new(vec![]));
                let result = match request {
                    Ok(request) => execute(request, &calls).await,
                    Err(error) => Err(error.to_string()),
                };
                let (ok, output, error) = match result
                    .and_then(|value| to_raw_value(&JsonData(&value)).map_err(|e| e.to_string()))
                {
                    Ok(value) => (true, Some(value), None),
                    Err(error) => (false, None, Some(error)),
                };
                serde_json::to_writer(
                    &mut stdout,
                    &Response {
                        id,
                        ok,
                        output,
                        error,
                        observed_calls: calls.borrow().clone(),
                    },
                )?;
                writeln!(&mut stdout)?;
            }
            Ok::<_, Box<dyn std::error::Error>>(())
        })
        .await
}
