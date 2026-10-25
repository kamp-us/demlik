use demlik_code_graph::{
    boundaries::{config::BoundaryRuleInputError, rules::BoundaryRules},
    text::JsValue,
    validation::{InputIssue, RecordTypeError},
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::io::{self, BufRead};
#[derive(Deserialize)]
struct Request {
    id: String,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Serialize)]
#[serde(untagged)]
enum Output {
    Parsed {
        success: bool,
        data: Box<BoundaryRules>,
    },
    Invalid {
        success: bool,
        issue: InputIssue,
    },
    Thrown {
        thrown: RecordTypeError,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: Option<String>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<Output>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostic: Option<String>,
    observed_calls: Vec<&'static str>,
}
fn execute(request: &Request, calls: &mut Vec<&'static str>) -> Result<Output, String> {
    if request.operation != "code_graph.boundary-config" {
        return Err("unsupported operation".into());
    }
    let value = JsValue::parse(request.input.get()).map_err(|error| error.to_string())?;
    let parsed = demlik_code_graph::boundaries::rules::BoundaryRules::parse(&value);
    calls.push("demlik_code_graph::boundaries::rules::BoundaryRules::parse");
    Ok(match parsed {
        Ok(data) => Output::Parsed {
            success: true,
            data: Box::new(data),
        },
        Err(BoundaryRuleInputError::Issue(issue)) => Output::Invalid {
            success: false,
            issue,
        },
        Err(BoundaryRuleInputError::TypeError(thrown)) => Output::Thrown { thrown },
    })
}
fn main() {
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else {
            break;
        };
        let request = serde_json::from_str::<Request>(&line);
        let mut observed_calls = Vec::new();
        let result = request
            .as_ref()
            .map_err(|error| error.to_string())
            .and_then(|request| execute(request, &mut observed_calls));
        let response = Response {
            id: request.as_ref().ok().map(|request| request.id.clone()),
            ok: result.is_ok(),
            error: result.as_ref().err().map(|_| "driver_error"),
            diagnostic: result.as_ref().err().cloned(),
            output: result.ok(),
            observed_calls,
        };
        println!(
            "{}",
            serde_json::to_string(&response).expect("response is JSON data")
        );
    }
}
