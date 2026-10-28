use demlik_code_graph::{
    api::base::GitReadFailure,
    extract::assemble::{NodeFields, assemble_graph},
    hotspots::{ChurnData, ChurnFailure, ChurnWindow, HotspotRow},
    project::{Collation, load_cheap_project},
    schema::{Graph, Thresholds},
    text::{JsString, JsValue},
};
use indexmap::IndexMap;
use serde::Deserialize;
use std::{
    error::Error,
    fs,
    io::{self, BufRead},
    path::{Path, PathBuf},
};
macro_rules! observe { ($calls:expr, $function:path $(,$argument:expr)* $(,)?) => {{ let value=$function($($argument),*); $calls.push(stringify!($function)); value }}; }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    id: String,
    mode: String,
    #[serde(default)]
    files: Vec<JsString>,
    #[serde(default)]
    functions: Vec<Function>,
    #[serde(default)]
    tracked: Vec<JsString>,
    #[serde(default)]
    commits: Vec<(JsString, JsValue)>,
    #[serde(default)]
    limits: Vec<JsValue>,
    #[serde(default)]
    pairs: Vec<[JsString; 2]>,
    window: Option<Window>,
    extra_window: Option<Window>,
    root: Option<JsString>,
    #[serde(default)]
    real_graph: bool,
    #[serde(default)]
    queries: Vec<JsString>,
}
#[derive(Deserialize)]
struct Function {
    file: JsString,
    complexity: JsValue,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Window {
    since_iso: JsString,
    until_iso: JsString,
    days: JsValue,
}
fn numeric(value: &JsValue) -> Result<f64, Box<dyn Error>> {
    if let JsValue::Number(n) = value {
        return Ok(*n);
    }
    if let JsValue::String(s) = value {
        return match s.to_utf8()?.as_str() {
            "NaN" => Ok(f64::NAN),
            "Infinity" => Ok(f64::INFINITY),
            "-Infinity" => Ok(f64::NEG_INFINITY),
            "-0" => Ok(-0.0),
            _ => Err("invalid Number label".into()),
        };
    }
    Err("expected Number".into())
}
impl Window {
    fn value(&self) -> Result<ChurnWindow, Box<dyn Error>> {
        Ok(ChurnWindow {
            since_iso: self.since_iso.clone(),
            until_iso: self.until_iso.clone(),
            days: numeric(&self.days)?,
        })
    }
}
fn obj<const N: usize>(fields: [(&str, JsValue); N]) -> JsValue {
    JsValue::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn arr(values: impl IntoIterator<Item = JsValue>) -> JsValue {
    JsValue::Array(values.into_iter().collect())
}
fn s(value: impl Into<JsString>) -> JsValue {
    JsValue::String(value.into())
}
fn n(value: f64) -> JsValue {
    if value.is_nan() {
        s("NaN")
    } else if value == f64::INFINITY {
        s("Infinity")
    } else if value == f64::NEG_INFINITY {
        s("-Infinity")
    } else if value == 0.0 && value.is_sign_negative() {
        s("-0")
    } else {
        JsValue::Number(value)
    }
}
fn option(value: Option<f64>) -> JsValue {
    value.map_or(JsValue::Null, n)
}
fn row_values(rows: &[HotspotRow]) -> JsValue {
    arr(rows.iter().map(|r| {
        obj([
            ("file", s(r.file.clone())),
            ("churn", option(r.churn)),
            ("complexity", n(r.complexity)),
            ("product", option(r.product)),
        ])
    }))
}
fn parts_report(
    input: &Input,
    churn: &ChurnData,
    window: &Window,
    calls: &mut Vec<&'static str>,
) -> Result<JsValue, Box<dyn Error>> {
    let before_files = input
        .files
        .iter()
        .map(|file| file.units().to_vec())
        .collect::<Vec<_>>();
    let functions = input
        .functions
        .iter()
        .map(|f| Ok((&f.file, numeric(&f.complexity)?)))
        .collect::<Result<Vec<_>, Box<dyn Error>>>()?;
    let before_functions = functions
        .iter()
        .map(|(file, value)| (file.units().to_vec(), value.to_bits()))
        .collect::<Vec<_>>();
    let collation = Collation::try_node22_en_us()?;
    let rows = observe!(
        calls,
        demlik_code_graph::hotspots::compute_hotspots_from_parts,
        input.files.iter(),
        functions.iter().copied(),
        churn,
        &collation
    )?;
    drop(collation);
    let window = window.value()?;
    let renders = input
        .limits
        .iter()
        .map(|limit| {
            let value = numeric(limit)?;
            Ok(obj([
                ("limit", limit.clone()),
                (
                    "human",
                    s(observe!(
                        calls,
                        demlik_code_graph::hotspots::render_hotspot_rows,
                        &rows,
                        &churn.head_sha,
                        &window,
                        value,
                        false,
                        false
                    )?),
                ),
                (
                    "compact",
                    s(observe!(
                        calls,
                        demlik_code_graph::hotspots::render_hotspot_rows,
                        &rows,
                        &churn.head_sha,
                        &window,
                        value,
                        true,
                        false
                    )?),
                ),
                (
                    "pretty",
                    s(observe!(
                        calls,
                        demlik_code_graph::hotspots::render_hotspot_rows,
                        &rows,
                        &churn.head_sha,
                        &window,
                        value,
                        true,
                        true
                    )?),
                ),
            ]))
        })
        .collect::<Result<Vec<_>, Box<dyn Error>>>()?;
    assert_eq!(
        before_files,
        input
            .files
            .iter()
            .map(|file| file.units().to_vec())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        before_functions,
        functions
            .iter()
            .map(|(file, value)| (file.units().to_vec(), value.to_bits()))
            .collect::<Vec<_>>()
    );
    Ok(obj([
        ("rows", row_values(&rows)),
        ("renders", arr(renders)),
        ("inputUnchanged", JsValue::Bool(true)),
        ("moduleOrderUnchanged", JsValue::Bool(true)),
        ("functionOrderUnchanged", JsValue::Bool(true)),
    ]))
}
fn graph_report(
    graph: &Graph,
    churn: &ChurnData,
    window: &ChurnWindow,
    collation: &Collation,
    calls: &mut Vec<&'static str>,
) -> Result<JsValue, Box<dyn Error>> {
    let before = serde_json::to_string(graph)?;
    let rows = observe!(
        calls,
        demlik_code_graph::hotspots::compute_hotspots,
        graph,
        churn,
        collation
    )?;
    let renders = [0., 2., 99.]
        .into_iter()
        .map(|limit| {
            Ok(obj([
                ("limit", n(limit)),
                (
                    "human",
                    s(observe!(
                        calls,
                        demlik_code_graph::hotspots::render_hotspots,
                        graph,
                        churn,
                        window,
                        limit,
                        false,
                        false,
                        collation
                    )?),
                ),
                (
                    "compact",
                    s(observe!(
                        calls,
                        demlik_code_graph::hotspots::render_hotspots,
                        graph,
                        churn,
                        window,
                        limit,
                        true,
                        false,
                        collation
                    )?),
                ),
                (
                    "pretty",
                    s(observe!(
                        calls,
                        demlik_code_graph::hotspots::render_hotspots,
                        graph,
                        churn,
                        window,
                        limit,
                        true,
                        true,
                        collation
                    )?),
                ),
            ]))
        })
        .collect::<Result<Vec<_>, Box<dyn Error>>>()?;
    assert_eq!(before, serde_json::to_string(graph)?);
    Ok(obj([
        ("rows", row_values(&rows)),
        ("renders", arr(renders)),
        ("inputUnchanged", JsValue::Bool(true)),
        ("moduleOrderUnchanged", JsValue::Bool(true)),
        ("functionOrderUnchanged", JsValue::Bool(true)),
    ]))
}
fn capture_read(
    read: &GitReadFailure,
    directory: &Path,
    label: &str,
) -> Result<JsValue, Box<dyn Error>> {
    fs::create_dir_all(directory)?;
    let stdout = directory.join(format!("{label}.stdout"));
    let stderr = directory.join(format!("{label}.stderr"));
    fs::write(&stdout, &read.stdout)?;
    fs::write(&stderr, &read.stderr)?;
    Ok(obj([
        ("cwd", s(read.cwd.clone())),
        ("arguments", arr(read.arguments.iter().cloned().map(s))),
        ("stdout", s(stdout.to_string_lossy().as_ref())),
        ("stdoutBytes", n(read.stdout.len() as f64)),
        ("stderr", s(stderr.to_string_lossy().as_ref())),
        ("stderrBytes", n(read.stderr.len() as f64)),
        (
            "status",
            read.status
                .and_then(|status| status.code())
                .map_or(JsValue::Null, |v| n(f64::from(v))),
        ),
        (
            "failures",
            arr(read.failures.iter().map(|failure| s(failure.to_string()))),
        ),
    ]))
}
fn failure(error: &ChurnFailure, directory: &Path, label: &str) -> Result<JsValue, Box<dyn Error>> {
    let data = match error {
        ChurnFailure::Git { read, .. } | ChurnFailure::Diagnostic { read, .. } => {
            capture_read(read, directory, label)?
        }
        ChurnFailure::Io { path, source, .. } => obj([
            ("path", s(path.clone())),
            ("message", s(source.to_string())),
            (
                "rawOS",
                source
                    .raw_os_error()
                    .map_or(JsValue::Null, |v| n(f64::from(v))),
            ),
        ]),
    };
    Ok(obj([("stage", s(error.stage().as_str())), ("data", data)]))
}
struct Probe<'a> {
    directory: &'a Path,
    calls: Vec<&'static str>,
    failures: Vec<JsValue>,
}
fn loaded(
    input: &Input,
    window: &Window,
    graph: Option<&Graph>,
    collation: Option<&Collation>,
    label: &str,
    probe: &mut Probe<'_>,
) -> Result<JsValue, Box<dyn Error>> {
    let directory = probe.directory;
    let calls = &mut probe.calls;
    let failures = &mut probe.failures;
    let window = window.value()?;
    let root = input.root.as_ref().ok_or("root required")?;
    let churn = match observe!(
        calls,
        demlik_code_graph::hotspots::load_churn_blocking,
        root,
        &window
    ) {
        Ok(churn) => churn,
        Err(error) => {
            failures.push(failure(&error, directory, label)?);
            return Ok(JsValue::Null);
        }
    };
    let queries = input.queries.iter().map(|file| {
        arr([
            s(file.clone()),
            option(observe!(
                calls,
                demlik_code_graph::hotspots::churn_for,
                &churn,
                file
            )),
        ])
    });
    let data = obj([
        ("repoRoot", s(churn.repo_root.clone())),
        ("headSha", s(churn.head_sha.clone())),
        (
            "commitsByFile",
            arr(churn
                .commits_by_file
                .iter()
                .map(|(key, value)| arr([s(key.clone()), n(*value)]))),
        ),
        (
            "trackedFiles",
            arr(churn.tracked_files.iter().cloned().map(s)),
        ),
        ("queries", arr(queries)),
    ]);
    let (graph_view, report) = if let Some(graph) = graph {
        (
            obj([
                (
                    "modules",
                    arr(graph.modules.iter().map(|m| s(m.file.as_str()))),
                ),
                (
                    "functions",
                    arr(graph
                        .functions
                        .iter()
                        .map(|f| arr([s(f.file.as_str()), n(f.complexity as f64)]))),
                ),
            ]),
            graph_report(
                graph,
                &churn,
                &window,
                collation.ok_or("Graph owns prepared collation")?,
                calls,
            )?,
        )
    } else {
        (JsValue::Null, JsValue::Null)
    };
    Ok(obj([
        ("data", data),
        ("graph", graph_view),
        ("report", report),
    ]))
}
fn one(input: &Input, directory: &Path) -> Result<JsValue, Box<dyn Error>> {
    let mut probe = Probe {
        directory,
        calls: vec![],
        failures: vec![],
    };
    let output = match input.mode.as_str() {
        "options" => arr(input.pairs.iter().map(|pair| {
            let result = observe!(
                &mut probe.calls,
                demlik_code_graph::hotspots::resolve_hotspots_cli_options,
                &pair[0],
                &pair[1]
            );
            match result {
                Ok(value) => obj([
                    (
                        "value",
                        obj([("days", n(value.days)), ("limit", n(value.limit))]),
                    ),
                    ("reports", arr([])),
                ]),
                Err(error) => obj([
                    ("value", JsValue::Null),
                    ("reports", arr([s(error.message())])),
                ]),
            }
        })),
        "pure" => {
            let churn = ChurnData {
                repo_root: "/repo".into(),
                head_sha: "abcd".into(),
                commits_by_file: input
                    .commits
                    .iter()
                    .map(|(file, value)| Ok((file.clone(), numeric(value)?)))
                    .collect::<Result<IndexMap<_, _>, Box<dyn Error>>>()?,
                tracked_files: input.tracked.iter().cloned().collect(),
            };
            let value = parts_report(
                input,
                &churn,
                input.window.as_ref().ok_or("window required")?,
                &mut probe.calls,
            )?;
            let JsValue::Object(mut fields) = value else {
                unreachable!()
            };
            fields.insert("profile".into(), s("authored-parts"));
            JsValue::Object(fields)
        }
        "load" => {
            let collation = if input.real_graph {
                Some(Collation::try_node22_en_us()?)
            } else {
                None
            };
            let graph = if input.real_graph {
                let root = input.root.as_ref().ok_or("root required")?.to_lossy();
                let project = load_cheap_project(
                    Path::new(&root),
                    None,
                    collation.as_ref().ok_or("collation required")?,
                )?;
                Some(assemble_graph(
                    &project,
                    Thresholds::default(),
                    NodeFields::default(),
                    collation.as_ref().ok_or("collation required")?,
                )?)
            } else {
                None
            };
            let first = loaded(
                input,
                input.window.as_ref().ok_or("window required")?,
                graph.as_ref(),
                collation.as_ref(),
                &input.id,
                &mut probe,
            )?;
            let mut fields = IndexMap::from([
                (
                    "profile".into(),
                    s(if input.real_graph {
                        "canonical-Graph"
                    } else {
                        "Git-only"
                    }),
                ),
                ("loaded".into(), first),
            ]);
            if let Some(window) = &input.extra_window {
                fields.insert(
                    "repeated".into(),
                    loaded(
                        input,
                        window,
                        graph.as_ref(),
                        collation.as_ref(),
                        &format!("{}-repeat", input.id),
                        &mut probe,
                    )?,
                );
            }
            JsValue::Object(fields)
        }
        _ => return Err("unknown mode".into()),
    };
    Ok(obj([
        ("id", s(input.id.as_str())),
        ("ok", JsValue::Bool(true)),
        ("output", output),
        ("nativeTrace", arr(probe.calls.into_iter().map(s))),
        ("nativeOnlyFailures", arr(probe.failures)),
    ]))
}
fn main() -> Result<(), Box<dyn Error>> {
    let directory = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("capture directory required")?,
    );
    for line in io::stdin().lock().lines() {
        let input: Input = serde_json::from_str(&line?)?;
        println!("{}", serde_json::to_string(&one(&input, &directory)?)?);
    }
    Ok(())
}
