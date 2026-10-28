use demlik_code_graph::{
    layers::resolve_target::{TargetResolver, create_target_resolver},
    text::JsString,
};
use serde::{Deserialize, Deserializer, Serialize, de::Error};
use serde_json::value::{RawValue, to_raw_value};
use std::{
    fs,
    io::{self, BufRead},
    path::Path,
};

macro_rules! observe {
    ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{
        let result = $function($($argument),*);
        $calls.push(stringify!($function));
        result
    }};
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    repo_root: JsString,
    steps: Vec<Step>,
}
enum Step {
    Resolve {
        from_file: JsString,
        specifier: JsString,
    },
    Write {
        file: JsString,
        contents: String,
    },
}
impl<'de> Deserialize<'de> for Step {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Action {
            action: String,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Resolve {
            action: String,
            from_file: JsString,
            specifier: JsString,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Write {
            action: String,
            file: JsString,
            contents: String,
        }
        let raw = Box::<RawValue>::deserialize(deserializer)?;
        let action: Action = serde_json::from_str(raw.get()).map_err(D::Error::custom)?;
        match action.action.as_str() {
            "resolve" => {
                let value: Resolve = serde_json::from_str(raw.get()).map_err(D::Error::custom)?;
                let _ = value.action;
                Ok(Self::Resolve {
                    from_file: value.from_file,
                    specifier: value.specifier,
                })
            }
            "write" => {
                let value: Write = serde_json::from_str(raw.get()).map_err(D::Error::custom)?;
                let _ = value.action;
                Ok(Self::Write {
                    file: value.file,
                    contents: value.contents,
                })
            }
            _ => Err(D::Error::custom(format!(
                "unsupported step: {}",
                action.action
            ))),
        }
    }
}
#[derive(Serialize)]
struct DriverError {
    kind: &'static str,
    message: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: Option<String>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<DriverError>,
    observed_calls: Vec<&'static str>,
}
#[derive(Serialize)]
struct Thrown {
    kind: &'static str,
    diagnostic: String,
}
fn error_kind(error: &io::Error) -> &'static str {
    match error.kind() {
        io::ErrorKind::NotFound => "not-found",
        io::ErrorKind::NotADirectory => "not-a-directory",
        io::ErrorKind::PermissionDenied => "permission-denied",
        io::ErrorKind::InvalidInput => "invalid-input",
        _ => "other-io",
    }
}
fn execute(request: Request, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, String> {
    let metadata_collation = demlik_code_graph::project::Collation::try_node22_en_us()
        .map_err(|error| error.to_string())?;

    if request.operation != "code_graph.layer_targets" {
        return Err(format!("unsupported operation: {}", request.operation));
    }
    let input: Input =
        serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
    let root_text = input.repo_root.to_lossy();
    let root = Path::new(&root_text);
    let output =
        (|| -> Result<_, demlik_code_graph::layers::resolve_target::TargetResolverError> {
            let mut resolver = observe!(calls, create_target_resolver, root, &metadata_collation)?;
            let mut targets = Vec::new();
            for step in input.steps {
                match step {
                    Step::Resolve {
                        from_file,
                        specifier,
                    } => targets.push(observe!(
                        calls,
                        TargetResolver::resolve,
                        &mut resolver,
                        &from_file,
                        &specifier
                    )?),
                    Step::Write { file, contents } => {
                        fs::write(root.join(file.to_lossy()), contents)?
                    }
                }
            }
            Ok(targets)
        })();
    match output {
        Ok(targets) => to_raw_value(&targets),
        Err(error) => {
            #[derive(Serialize)]
            struct Failure {
                thrown: Thrown,
            }
            to_raw_value(&Failure {
                thrown: Thrown {
                    kind: match &error { demlik_code_graph::layers::resolve_target::TargetResolverError::Io(error) => error_kind(error), demlik_code_graph::layers::resolve_target::TargetResolverError::Collation(_) => "collation-error" },
                    diagnostic: error.to_string(),
                },
            })
        }
    }
    .map_err(|error| error.to_string())
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let request = serde_json::from_str::<Request>(&line?);
        let id = request.as_ref().map(|request| request.id.clone()).ok();
        let mut observed_calls = Vec::new();
        let result = request
            .map_err(|error| error.to_string())
            .and_then(|request| execute(request, &mut observed_calls));
        let (ok, output, error) = match result {
            Ok(output) => (true, Some(output), None),
            Err(message) => (
                false,
                None,
                Some(DriverError {
                    kind: "driver-error",
                    message,
                }),
            ),
        };
        println!(
            "{}",
            serde_json::to_string(&Response {
                id,
                ok,
                output,
                error,
                observed_calls
            })?
        );
    }
    Ok(())
}
