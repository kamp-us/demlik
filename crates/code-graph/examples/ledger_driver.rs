use demlik_code_graph::{boundaries::ledger::*, text::JsString};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    fs,
    io::{self, BufRead},
    path::Path,
    sync::Arc,
};

macro_rules! observe {
    ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{
        let returned = $function($($argument),*);
        $calls.push(stringify!($function));
        returned
    }};
}
macro_rules! observe_value {
    ($calls:expr, $value:path) => {{
        let value = $value;
        $calls.push(stringify!($value));
        value
    }};
}
#[derive(Deserialize)]
struct Request {
    id: String,
    operation: String,
    input: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ParseInput {
    text: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PureInput {
    entries: Vec<BoundaryLedgerEntry>,
    #[serde(default)]
    moves: Vec<FileMove>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileInput {
    path: String,
    initial: Option<String>,
    #[serde(default)]
    moves: Vec<FileMove>,
    write_entries: Option<Vec<BoundaryLedgerEntry>>,
    #[serde(default)]
    directory: bool,
}
#[derive(Serialize)]
struct PureOutput<'a> {
    kinds: &'static [BoundaryKind],
    filename: &'static str,
    keys: Vec<String>,
    targets: Vec<&'a JsString>,
    ledger: &'a BoundaryLedger,
    moved: BoundaryLedger,
    json: String,
    picked: Vec<usize>,
}
#[derive(Serialize)]
struct FileOutput {
    before: LedgerRead,
    rekey: LedgerFileRekey,
    after: LedgerRead,
    text: Option<String>,
    exists: bool,
}
#[derive(Serialize)]
struct Problem {
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
}
impl From<serde_json::Error> for Problem {
    fn from(_: serde_json::Error) -> Self {
        Self {
            kind: "driver_error",
            code: None,
        }
    }
}
impl From<io::Error> for Problem {
    fn from(error: io::Error) -> Self {
        Self {
            kind: "api_error",
            code: Some(match error.kind() {
                io::ErrorKind::IsADirectory => "EISDIR",
                io::ErrorKind::NotFound => "ENOENT",
                io::ErrorKind::PermissionDenied => "EACCES",
                _ => "IO",
            }),
        }
    }
}
fn encode(value: &impl Serialize) -> Result<Box<RawValue>, Problem> {
    Ok(RawValue::from_string(serde_json::to_string(value)?)?)
}
fn execute(request: &Request, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, Problem> {
    match request.operation.as_str() {
        "code_graph.ledger.parse" => {
            let input: ParseInput = serde_json::from_str(request.input.get())?;
            encode(&observe!(
                calls,
                demlik_code_graph::boundaries::ledger::parse_boundary_ledger,
                &input.text
            ))
        }
        "code_graph.ledger.pure" => {
            let input: PureInput = serde_json::from_str(request.input.get())?;
            let entries = input.entries.into_iter().map(Arc::new).collect::<Vec<_>>();
            let keys = entries
                .iter()
                .map(|entry| {
                    observe!(
                        calls,
                        demlik_code_graph::boundaries::ledger::ledger_key,
                        entry
                    )
                })
                .collect();
            let targets = entries
                .iter()
                .map(|entry| {
                    observe!(
                        calls,
                        demlik_code_graph::boundaries::ledger::ledger_target_of,
                        entry
                    )
                })
                .collect();
            let ledger = observe!(
                calls,
                demlik_code_graph::boundaries::ledger::boundary_ledger_of,
                &entries
            );
            let picked = ledger
                .entries
                .iter()
                .map(|held| {
                    entries
                        .iter()
                        .position(|entry| Arc::ptr_eq(held, entry))
                        .expect("canonical entry retains an input owner")
                })
                .collect();
            let moved = observe!(
                calls,
                demlik_code_graph::boundaries::ledger::rekey_boundary_ledger,
                &ledger,
                &input.moves
            );
            let json = observe!(
                calls,
                demlik_code_graph::boundaries::ledger::serialize_boundary_ledger,
                &ledger
            );
            encode(&PureOutput {
                kinds: observe_value!(calls, demlik_code_graph::boundaries::ledger::BOUNDARY_KINDS),
                filename: observe_value!(
                    calls,
                    demlik_code_graph::boundaries::ledger::LEDGER_FILENAME
                ),
                keys,
                targets,
                ledger: &ledger,
                moved,
                json,
                picked,
            })
        }
        "code_graph.ledger.file" => {
            let input: FileInput = serde_json::from_str(request.input.get())?;
            let file = Path::new(&input.path);
            if file.is_dir() {
                fs::remove_dir(file)?;
            } else if file.exists() {
                fs::remove_file(file)?;
            }
            fs::create_dir_all(file.parent().expect("fixture path has a parent"))?;
            if input.directory {
                fs::create_dir(file)?;
            } else if let Some(text) = input.initial {
                fs::write(file, text)?;
            }
            if let Some(entries) = input.write_entries {
                let ledger = BoundaryLedger {
                    entries: entries.into_iter().map(Arc::new).collect(),
                };
                observe!(
                    calls,
                    demlik_code_graph::boundaries::ledger::write_boundary_ledger,
                    file,
                    &ledger
                )?;
            }
            let before = observe!(
                calls,
                demlik_code_graph::boundaries::ledger::read_boundary_ledger,
                file
            )?;
            let rekey = observe!(
                calls,
                demlik_code_graph::boundaries::ledger::rekey_boundary_ledger_file,
                file,
                &input.moves
            )?;
            let after = observe!(
                calls,
                demlik_code_graph::boundaries::ledger::read_boundary_ledger,
                file
            )?;
            let text = if file.exists() {
                Some(String::from_utf8_lossy(&fs::read(file)?).into_owned())
            } else {
                None
            };
            encode(&FileOutput {
                before,
                rekey,
                after,
                text,
                exists: file.exists(),
            })
        }
        _ => Err(Problem {
            kind: "driver_error",
            code: None,
        }),
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    id: Option<String>,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Problem>,
    observed_calls: Vec<&'static str>,
}
fn main() {
    for line in io::stdin().lock().lines() {
        let mut calls = vec![];
        let request = line
            .ok()
            .and_then(|line| serde_json::from_str::<Request>(&line).ok());
        let (id, result) = match request {
            Some(request) => (Some(request.id.clone()), execute(&request, &mut calls)),
            None => (
                None,
                Err(Problem {
                    kind: "driver_error",
                    code: None,
                }),
            ),
        };
        let (output, error) = match result {
            Ok(output) => (Some(output), None),
            Err(error) => (None, Some(error)),
        };
        println!(
            "{}",
            serde_json::to_string(&Response {
                id,
                ok: error.is_none(),
                output,
                error,
                observed_calls: calls
            })
            .expect("wire responses contain JSON data")
        );
    }
}
