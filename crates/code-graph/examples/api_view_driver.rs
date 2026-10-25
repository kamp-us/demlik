use demlik_code_graph::{
    api::{
        emit::{self, DeclarationEmit},
        map::{ApiError, ApiInputError, ApiSubpath},
        model::SubpathNames,
        read::read_subpath_names,
        text,
        view::PublishedApiOptions,
    },
    engine::tsgo::{ProgramInput, TsgoBinary, open_type_session},
    text::{JsString, JsValue},
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    fs,
    io::{self, BufRead},
    path::{Path, PathBuf},
    sync::Arc,
};
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Subpath {
    subpath: JsString,
    entry: JsString,
    entry_absolute: JsString,
    #[serde(deserialize_with = "required_option")]
    tier: Option<JsString>,
}
impl From<Subpath> for ApiSubpath {
    fn from(v: Subpath) -> Self {
        Self {
            subpath: v.subpath,
            entry: v.entry,
            entry_absolute: v.entry_absolute,
            tier: v.tier,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Emit {
    temp: JsString,
    out: JsString,
    compiler: JsString,
    diagnostics: JsNumberInput,
}
impl From<Emit> for DeclarationEmit {
    fn from(v: Emit) -> Self {
        Self {
            temp: v.temp,
            out: v.out,
            compiler: v.compiler,
            diagnostics: v.diagnostics.value(),
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    kind: String,
    nth: usize,
}
fn required_option<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    Option::deserialize(d)
}
fn data(v: &impl Serialize) -> Result<JsValue, serde_json::Error> {
    JsValue::parse(&serde_json::to_string(v)?)
}
fn obj(rows: impl IntoIterator<Item = (&'static str, JsValue)>) -> JsValue {
    JsValue::Object(rows.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn fields(v: &JsValue, allowed: &[&str]) -> Result<(), String> {
    let o = v.as_object().ok_or("expected object")?;
    if o.keys()
        .any(|key| !allowed.iter().any(|allowed| key == *allowed))
    {
        return Err("unknown input field".into());
    }
    Ok(())
}
fn field<'a>(v: &'a JsValue, key: &str) -> Result<&'a JsValue, String> {
    v.get(key).ok_or(format!("missing field {key}"))
}
fn decode<T: serde::de::DeserializeOwned>(v: &JsValue) -> Result<T, String> {
    serde_json::from_str(&serde_json::to_string(v).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn thrown(error: &ApiError) -> JsValue {
    let mut value = obj([
        ("name", JsValue::String(error.name().into())),
        ("message", JsValue::String(error.message())),
    ]);
    if let ApiError::Argument(error) = error
        && let JsValue::Object(record) = &mut value
    {
        record.insert("code".into(), JsValue::String(error.code().into()));
        record.insert("argument".into(), JsValue::String(error.argument().clone()));
        record.insert(
            "location".into(),
            JsValue::String(error.location().label().into()),
        );
    }
    value
}

fn inventory() -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    for entry in fs::read_dir(std::env::temp_dir()).map_err(|error| error.to_string())? {
        let name = entry
            .map_err(|error| error.to_string())?
            .file_name()
            .to_string_lossy()
            .into_owned();
        if name.starts_with("code-graph-api-") {
            files.push(name);
        }
    }
    files.sort();
    Ok(files)
}
fn watched(paths: &[JsString]) -> JsValue {
    JsValue::Array(
        paths
            .iter()
            .map(|path| JsValue::Bool(Path::new(&path.to_lossy()).exists()))
            .collect(),
    )
}
fn rows(names: &SubpathNames) -> Result<JsValue, serde_json::Error> {
    let entries = demlik_code_graph::text::object_keys(&names.entries)
        .into_iter()
        .map(|key| &names.entries[key])
        .collect::<Vec<_>>();
    let shared = entries
        .iter()
        .map(|left| {
            entries
                .iter()
                .map(|right| Arc::ptr_eq(left, right))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    Ok(obj([
        ("names", data(names)?),
        (
            "keys",
            data(&demlik_code_graph::text::object_keys(&names.entries))?,
        ),
        ("prototype", data(&names.prototype())?),
        ("identity", data(&shared)?),
    ]))
}
fn execute(
    request: Request,
    compiler: &TsgoBinary,
    calls: &mut Vec<&'static str>,
) -> Result<JsValue, String> {
    if request.operation != "code_graph.api-view" {
        return Err("unsupported operation".into());
    }
    let input = JsValue::parse(request.input.get()).map_err(|e| e.to_string())?;
    let action: String = decode(field(&input, "action")?)?;
    match action.as_str() {
        "text" => {
            fields(&input, &["action", "text"])?;
            let raw: JsString = decode(field(&input, "text")?)?;
            let clean = observe!(calls, text::without_comments, &raw);
            let tidy = observe!(calls, text::tidy_lines, &raw);
            let declaration = observe!(calls, text::tidy_lines, &clean);
            Ok(obj([
                ("clean", JsValue::String(clean)),
                ("tidy", JsValue::String(tidy)),
                ("declaration", JsValue::String(declaration)),
            ]))
        }
        "file" => {
            fields(&input, &["action", "emit", "root", "entry"])?;
            let emit: DeclarationEmit = decode::<Emit>(field(&input, "emit")?)?.into();
            let root: JsString = decode(field(&input, "root")?)?;
            let entry: JsString = decode(field(&input, "entry")?)?;
            match observe!(calls, emit::emitted_file_of, &emit, &root, &entry) {
                Ok(file) => Ok(obj([("file", JsValue::String(file))])),
                Err(error) => Ok(obj([("thrown", thrown(&error))])),
            }
        }
        "package" => {
            fields(&input, &["action", "root"])?;
            let root: JsString = decode(field(&input, "root")?)?;
            match observe!(calls, demlik_code_graph::api::view::package_root, &root) {
                Ok(root) => {
                    let relative =
                        observe!(calls, demlik_code_graph::api::view::project_relative, &root)
                            .map_err(|e| e.to_string())?;
                    Ok(obj([
                        ("root", JsValue::String(root)),
                        ("relative", JsValue::String(relative)),
                    ]))
                }
                Err(error) => Ok(obj([("thrown", thrown(&error))])),
            }
        }
        "remove" => {
            fields(&input, &["action", "temp", "watch"])?;
            let temp: JsString = decode(field(&input, "temp")?)?;
            let watch: Vec<JsString> = decode(field(&input, "watch")?)?;
            let result = observe!(calls, emit::remove_emit, &temp);
            Ok(match result {
                Ok(()) => obj([
                    (
                        "exists",
                        JsValue::Bool(fs::symlink_metadata(temp.to_lossy()).is_ok()),
                    ),
                    ("watched", watched(&watch)),
                ]),
                Err(error) => obj([("thrown", thrown(&error)), ("watched", watched(&watch))]),
            })
        }
        "read" | "emitted" => {
            let allowed = if action == "read" {
                vec!["action", "root", "map", "repoRoot", "warn"]
            } else {
                vec!["action", "root", "subpaths", "repoRoot", "warn", "context"]
            };
            fields(&input, &allowed)?;
            let root: JsString = decode(field(&input, "root")?)?;
            let repo: Option<JsString> = decode(field(&input, "repoRoot")?)?;
            let mode: String = decode(field(&input, "warn")?)?;
            if !matches!(mode.as_str(), "collect" | "default" | "fail") {
                return Err("unknown warning mode".into());
            }
            let subpaths = if action == "emitted" {
                decode::<Vec<Subpath>>(field(&input, "subpaths")?)?
                    .into_iter()
                    .map(ApiSubpath::from)
                    .collect::<Vec<_>>()
            } else {
                vec![]
            };
            let context: Option<JsString> = if action == "emitted" {
                decode(field(&input, "context")?)?
            } else {
                None
            };
            let map = if action == "read" {
                Some(field(&input, "map")?)
            } else {
                None
            };
            let before = inventory()?;
            let mut warnings = Vec::new();
            let mut warn = |line: &JsString| {
                warnings.push(line.clone());
                if mode == "fail" {
                    Err(ApiError::Input(
                        ApiInputError::new(JsString::from_units(
                            "warning callback "
                                .encode_utf16()
                                .chain([0xd800])
                                .chain(" failed".encode_utf16())
                                .collect(),
                        ))
                        .with_cause(io::Error::other("callback cause retained")),
                    ))
                } else {
                    Ok(())
                }
            };
            let options = PublishedApiOptions {
                repo_root: repo.as_ref(),
                warn: if mode == "default" {
                    None
                } else {
                    Some(&mut warn)
                },
            };
            let result = if let Some(map) = map {
                observe!(
                    calls,
                    demlik_code_graph::api::view::read_published_api,
                    &root,
                    map,
                    compiler,
                    options
                )
                .and_then(|view| {
                    let prototypes = demlik_code_graph::text::object_keys(&view.subpaths)
                        .into_iter()
                        .map(|key| (key, view.subpaths[key].names.prototype()))
                        .collect::<Vec<_>>();
                    data(&view)
                        .map(|v| {
                            obj([
                                ("view", v),
                                (
                                    "prototypes",
                                    data(&prototypes).expect("prototype is JSON data"),
                                ),
                            ])
                        })
                        .map_err(|error| ApiError::Compiler(error.into()))
                })
            } else {
                observe!(
                    calls,
                    demlik_code_graph::api::view::read_emitted_names,
                    &root,
                    &subpaths,
                    compiler,
                    options,
                    context.as_ref()
                )
                .and_then(|emitted| {
                    let values = emitted
                        .names
                        .iter()
                        .map(|(key, names)| Ok((key, rows(names)?)))
                        .collect::<Result<Vec<_>, serde_json::Error>>()
                        .map_err(|error| ApiError::Compiler(error.into()))?;
                    Ok(obj([
                        ("compiler", JsValue::String(emitted.compiler)),
                        (
                            "names",
                            data(&values).map_err(|error| ApiError::Compiler(error.into()))?,
                        ),
                    ]))
                })
            };
            let after = inventory()?;
            let mut output = match result {
                Ok(value) => value,
                Err(error) => obj([("thrown", thrown(&error))]),
            };
            if let JsValue::Object(object) = &mut output {
                object.insert(
                    "warnings".into(),
                    data(&warnings).map_err(|e| e.to_string())?,
                );
                object.insert("tempClean".into(), JsValue::Bool(before == after));
            }
            Ok(output)
        }
        "emit" => {
            fields(&input, &["action", "root", "config", "subpaths"])?;
            let root: JsString = decode(field(&input, "root")?)?;
            let config: JsString = decode(field(&input, "config")?)?;
            let subpaths: Vec<ApiSubpath> = decode::<Vec<Subpath>>(field(&input, "subpaths")?)?
                .into_iter()
                .map(Into::into)
                .collect();
            let before = inventory()?;
            let mut result =
                match observe!(calls, emit::emit_declarations, &root, &config, compiler) {
                    Err(error) => obj([("thrown", thrown(&error))]),
                    Ok(emit) => {
                        let entries =
                            observe!(calls, emit::emitted_entries, &emit, &root, &subpaths);
                        let installed = PathBuf::from(emit.temp.to_lossy()).join("node_modules");
                        let target = fs::read_link(&installed)
                            .ok()
                            .map(|v| v.to_string_lossy().into_owned());
                        let result: Result<JsValue, String> = (|| {
                            Ok(match entries {
                                Err(error) => obj([("thrown", thrown(&error))]),
                                Ok(entries) => {
                                    let files = entries
                                        .iter()
                                        .map(|(key, file)| {
                                            (
                                                key,
                                                demlik_code_graph::project::to_relative(
                                                    Path::new(&emit.out.to_lossy()),
                                                    Path::new(&file.to_lossy()),
                                                ),
                                            )
                                        })
                                        .collect::<Vec<_>>();
                                    let text = entries
                                        .iter()
                                        .map(|(key, file)| {
                                            Ok((
                                                key,
                                                String::from_utf8_lossy(&fs::read(
                                                    file.to_lossy(),
                                                )?)
                                                .into_owned(),
                                            ))
                                        })
                                        .collect::<io::Result<Vec<_>>>()
                                        .map_err(|e| e.to_string())?;
                                    obj([
                                        ("compiler", JsValue::String(emit.compiler.clone())),
                                        ("diagnostics", JsValue::Number(emit.diagnostics)),
                                        ("files", data(&files).map_err(|e| e.to_string())?),
                                        ("text", data(&text).map_err(|e| e.to_string())?),
                                        (
                                            "dependencyLink",
                                            data(&target).map_err(|e| e.to_string())?,
                                        ),
                                        (
                                            "outsideRoot",
                                            JsValue::Bool(
                                                !Path::new(&emit.temp.to_lossy())
                                                    .starts_with(root.to_lossy()),
                                            ),
                                        ),
                                    ])
                                }
                            })
                        })();
                        let cleanup = observe!(calls, emit::remove_emit, &emit.temp)
                            .map_err(|e| e.to_string());
                        match (result, cleanup) {
                            (Ok(value), Ok(())) => value,
                            (Err(operation), Err(cleanup)) => {
                                return Err(format!("{operation}; cleanup also failed: {cleanup}"));
                            }
                            (Err(error), Ok(())) | (Ok(_), Err(error)) => return Err(error),
                        }
                    }
                };
            if let JsValue::Object(object) = &mut result {
                object.insert("tempClean".into(), JsValue::Bool(before == inventory()?));
            }
            Ok(result)
        }
        "program" | "nodes" => {
            let allowed = if action == "program" {
                vec!["action", "config", "out", "entries"]
            } else {
                vec!["action", "config", "file", "select"]
            };
            fields(&input, &allowed)?;
            let config: JsString = decode(field(&input, "config")?)?;
            let out: Option<JsString> = if action == "program" {
                Some(decode(field(&input, "out")?)?)
            } else {
                None
            };
            let entries: Vec<(JsString, JsString)> = if action == "program" {
                decode(field(&input, "entries")?)?
            } else {
                vec![("file".into(), decode(field(&input, "file")?)?)]
            };
            let roots = entries
                .iter()
                .map(|(_, file)| PathBuf::from(file.to_lossy()))
                .collect::<Vec<_>>();
            let select: Vec<Selection> = if action == "nodes" {
                decode(field(&input, "select")?)?
            } else {
                vec![]
            };
            if select.iter().any(|s| {
                !matches!(
                    s.kind.as_str(),
                    "SourceFile"
                        | "VariableDeclaration"
                        | "FunctionDeclaration"
                        | "ClassDeclaration"
                        | "InterfaceDeclaration"
                        | "ModuleDeclaration"
                )
            }) {
                return Err("unsupported node selection".into());
            }
            let result = (|| {
                let mut session = open_type_session(compiler, Path::new(&config.to_lossy()))?;
                session.with_compilation(
                    ProgramInput {
                        root_files: &roots,
                        include_config_files: false,
                    },
                    |program| {
                        if let Some(out) = out {
                            let mut results = Vec::new();
                            for (key, file) in entries {
                                let names = observe!(
                                    calls,
                                    read_subpath_names,
                                    program,
                                    &out,
                                    Path::new(&file.to_lossy())
                                )?;
                                results.push((key, rows(&names)?));
                            }
                            return Ok(data(&results)?);
                        }
                        let file = program.source_file(&roots[0])?.ok_or_else(|| {
                            demlik_code_graph::engine::tsgo::TsgoError::Protocol(
                                "source file missing".into(),
                            )
                        })?;
                        let mut all = vec![file.root()];
                        all.extend(file.root().descendants()?);
                        let mut results = Vec::new();
                        for select in select {
                            let node = all
                                .iter()
                                .filter(|node| node.kind_name() == Some(select.kind.as_str()))
                                .nth(select.nth)
                                .ok_or_else(|| {
                                    demlik_code_graph::engine::tsgo::TsgoError::Protocol(
                                        "selected node missing".into(),
                                    )
                                })?;
                            let statement = observe!(calls, text::statement_of, node)?;
                            let cleaned = observe!(calls, text::declaration_text, &statement)?;
                            results.push(obj([
                                ("kind", JsValue::String(select.kind.into())),
                                (
                                    "statementKind",
                                    JsValue::String(statement.kind_name().unwrap_or("").into()),
                                ),
                                ("text", JsValue::String(cleaned)),
                            ]));
                        }
                        Ok(JsValue::Array(results))
                    },
                )
            })();
            match result {
                Ok(result) => Ok(result),
                Err(error) => Ok(obj([("thrown", thrown(&ApiError::Compiler(error)))])),
            }
        }
        _ => Err("unsupported action".into()),
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let manifest = args.next().ok_or("provide native-preview package.json")?;
    if args.next().is_some() {
        return Err("unexpected argument".into());
    }
    let compiler = TsgoBinary::from_native_preview_manifest(Path::new(&manifest))?;
    for line in io::stdin().lock().lines() {
        let request = serde_json::from_str::<Request>(&line?);
        let id = request.as_ref().ok().map(|r| r.id.clone());
        let mut calls = Vec::new();
        let result = request
            .map_err(|e| e.to_string())
            .and_then(|r| execute(r, &compiler, &mut calls));
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
            output: Option<JsValue>,
            #[serde(skip_serializing_if = "Option::is_none")]
            error: Option<Error>,
            observed_calls: Vec<&'static str>,
        }
        let (output, error) = match result {
            Ok(v) => (Some(v), None),
            Err(message) => (
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
                ok: output.is_some(),
                output,
                error,
                observed_calls: calls
            })?
        );
    }
    Ok(())
}
