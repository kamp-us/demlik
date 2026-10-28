//! Temporary K baseline: invokes the unchanged census owners, not a replacement sort.
use demlik_code_graph::{
    boundaries::{
        deployables::{Deployables, census::SiteRow},
        libraries::{Libraries, LibrariesRead, census::MeasuredLibraries},
        render::Censuses,
        rules::{BoundaryRules, DeployableKind, LibraryType},
        violation::ScopeBoundaryReport,
    },
    extract::wrangler_config::{BindingCatalog, ServiceManifest},
    project::Collation,
    text::{JsString, object_keys},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{self, BufRead},
    path::Path,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    mode: String,
    rows: Vec<RowInput>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RowInput {
    id: Option<String>,
    alias: Option<String>,
    file: Option<JsString>,
    line: Option<serde_json::Value>,
    binding: Option<JsString>,
}
#[derive(Serialize)]
#[serde(untagged)]
enum Line {
    Label(&'static str),
    Number(f64),
}
fn line(value: f64) -> Line {
    if value.is_nan() {
        Line::Label("NaN")
    } else if value == f64::INFINITY {
        Line::Label("+Infinity")
    } else if value == f64::NEG_INFINITY {
        Line::Label("-Infinity")
    } else if value == 0.0 && value.is_sign_negative() {
        Line::Label("-0")
    } else {
        Line::Number(value)
    }
}
fn input_line(value: &serde_json::Value) -> f64 {
    match value {
        serde_json::Value::String(label) => match label.as_str() {
            "NaN" => f64::NAN,
            "+Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            "-0" => -0.0,
            _ => panic!("unknown numeric transport label"),
        },
        serde_json::Value::Number(number) => number.as_f64().expect("finite numeric fixture"),
        _ => panic!("numeric transport must be number or named nonfinite"),
    }
}
#[derive(Serialize)]
struct SiteView<'a> {
    file: &'a JsString,
    line: Line,
    binding: &'a JsString,
}
#[derive(Serialize)]
struct WorkerView<'a> {
    worker: &'a JsString,
    files: &'a [JsString],
    bindings: Vec<(&'a JsString, f64)>,
    sites: Vec<SiteView<'a>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    all_original_rows: bool,
    original_indices: Vec<Vec<usize>>,
    alias_input_materialized_as_separate_owned_rows: bool,
    qualification: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeployableView<'a> {
    workers: Option<Vec<WorkerView<'a>>>,
    unresolved: Option<f64>,
    input_order_unchanged: bool,
    lines: Option<Vec<JsString>>,
    report_text: JsString,
    report_json: JsString,
    report_pretty: JsString,
    identity: Vec<Identity>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryView<'a> {
    types: Vec<(&'a JsString, &'a Vec<JsString>)>,
    undeclared: &'a [JsString],
    unjudged_imports: Line,
    lines: Vec<JsString>,
    report_json: JsString,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Frame<'a, T> {
    id: &'a str,
    output: T,
    observed_calls: Vec<&'static str>,
}
fn manifest(service: &str, dir: &str) -> ServiceManifest {
    ServiceManifest {
        service: service.into(),
        dir: dir.into(),
        config_file: format!("{dir}/wrangler.json"),
        main: None,
        bindings: vec![],
        data_bindings: vec![],
        env_keys: vec![],
        binding_names: vec![],
        dev_vars_keys: vec![],
        dev_vars_files: vec![],
    }
}
fn deployable(request: &Request) -> Result<String, Box<dyn std::error::Error>> {
    let catalog = BindingCatalog {
        manifests: vec![
            manifest("Z", "workers/Z"),
            manifest("a", "workers/a"),
            manifest("nested", "workers/Z/deep"),
        ],
        unparsed_configs: vec![],
    };
    let mut model: Deployables<'_> = Deployables::empty();
    model.catalog = &catalog;
    if request.id != "disabled" {
        model
            .kinds
            .insert(DeployableKind::BindingOutsideDrivenAdapter);
    }
    model.graph.workers = vec!["a".into(), "nested".into(), "Z".into()];
    model.graph.unresolved = 3;
    let mut rows: Vec<SiteRow> = Vec::new();
    let mut names: HashMap<String, usize> = HashMap::new();
    let mut has_alias = false;
    for input in &request.rows {
        if let Some(alias) = &input.alias {
            let original = &rows[*names.get(alias).expect("earlier Source reference")];
            // The old &[SiteRow] API cannot encode an aliased input. This
            // materialization is explicit evidence of that API limit, not identity.
            rows.push(SiteRow {
                file: original.file.clone(),
                line: original.line,
                binding: original.binding.clone(),
            });
            has_alias = true;
        } else {
            names.insert(input.id.as_ref().expect("row id").clone(), rows.len());
            rows.push(SiteRow {
                file: input
                    .file
                    .clone()
                    .unwrap_or_else(|| "workers/Z/src/file.ts".into()),
                line: input_line(input.line.as_ref().expect("line")),
                binding: input.binding.clone().expect("binding"),
            });
        }
    }
    let before: Vec<_> = rows
        .iter()
        .map(|r| (r.file.clone(), r.line.to_bits(), r.binding.clone()))
        .collect();
    let mut calls = vec!["demlik_code_graph::boundaries::deployables::census::deployable_census"];
    let census =
        demlik_code_graph::boundaries::deployables::census::deployable_census(&model, &rows);
    let reports = vec![ScopeBoundaryReport {
        scope: ".".into(),
        features: vec!["demo".into()],
        files_scanned: rows.len() as f64,
        violations: vec![],
        workers: None,
    }];
    let mut identity = Vec::new();
    let workers = census.as_ref().map(|c| c.workers.iter().map(|w| {
        let indices: Vec<Vec<usize>> = w.sites.iter().map(|site| rows.iter().enumerate().filter_map(|(i, original)| std::ptr::eq(original, site).then_some(i)).collect()).collect();
        identity.push(Identity {all_original_rows: indices.iter().all(|x| !x.is_empty()), original_indices: indices, alias_input_materialized_as_separate_owned_rows: has_alias, qualification: "Unchanged census owns cloned SiteRows; values do not prove original-reference identity."});
        WorkerView {worker: &w.worker, files: &w.files, bindings: object_keys(&w.bindings).into_iter().map(|key| (key,w.bindings[key])).collect(), sites: w.sites.iter().map(|s| SiteView {file: &s.file,line: line(s.line),binding: &s.binding}).collect()}
    }).collect());
    let lines = census.as_ref().map(|c| {
        calls.push("demlik_code_graph::boundaries::deployables::census::deployable_census_lines");
        demlik_code_graph::boundaries::deployables::census::deployable_census_lines(c)
    });
    let mut render = |json, pretty| {
        calls.push("demlik_code_graph::boundaries::render::render_boundaries");
        demlik_code_graph::boundaries::render::render_boundaries(
            &reports,
            &".".into(),
            Censuses {
                libraries: None,
                deployables: census.as_ref(),
            },
            json,
            pretty,
        )
    };
    let report_text = render(false, false)?;
    let report_json = render(true, false)?;
    let report_pretty = render(true, true)?;
    let unchanged = before
        == rows
            .iter()
            .map(|r| (r.file.clone(), r.line.to_bits(), r.binding.clone()))
            .collect::<Vec<_>>();
    let output = DeployableView {
        workers,
        unresolved: census.as_ref().map(|c| c.unresolved_service_bindings),
        input_order_unchanged: unchanged,
        lines,
        report_text,
        report_json,
        report_pretty,
        identity,
    };
    Ok(serde_json::to_string(&Frame {
        id: &request.id,
        output,
        observed_calls: calls,
    })?)
}
fn library(request: &Request, root: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let mut rules = BoundaryRules::default();
    for name in ["10", "2", "Z", "a", "unused"] {
        rules.library_types.insert(
            name.into(),
            LibraryType {
                imports: vec![],
                pure: false,
                imported_from: None,
            },
        );
    }
    for (dir, name) in [
        ("packages/Z", "Z"),
        ("packages/a", "a"),
        ("packages/ten", "10"),
        ("packages/two", "2"),
    ] {
        rules.libraries.insert(dir.into(), name.into());
    }
    let scopes = vec![
        "packages/Z".into(),
        "packages/a".into(),
        "packages/ten".into(),
        "packages/two".into(),
        "packages/a".into(),
    ];
    let undeclared = vec![
        "packages/Zz".into(),
        "packages/aa".into(),
        "packages/aa".into(),
    ];
    let mut calls = Vec::new();
    let libraries = if request.mode == "library-disabled" {
        Libraries::default()
    } else {
        let collation = Collation::try_node22_en_us()?;
        calls.push("demlik_code_graph::boundaries::libraries::read_libraries");
        match demlik_code_graph::boundaries::libraries::read_libraries(
            &rules, root, None, &collation,
        )? {
            LibrariesRead::Read(libraries) => libraries,
            LibrariesRead::Refused { message } => {
                return Err(format!("native fixture admission: {message}").into());
            }
        }
    };
    calls.push("demlik_code_graph::boundaries::libraries::census::library_census");
    let census = demlik_code_graph::boundaries::libraries::census::library_census(
        &libraries,
        MeasuredLibraries {
            scopes: &scopes,
            undeclared: &undeclared,
            unjudged: f64::INFINITY,
        },
    );
    let output = if let Some(census) = &census {
        calls.push("demlik_code_graph::boundaries::libraries::census::census_lines");
        let lines = demlik_code_graph::boundaries::libraries::census::census_lines(census);
        calls.push("demlik_code_graph::boundaries::render::render_boundaries");
        Some(LibraryView {
            types: object_keys(&census.types)
                .into_iter()
                .map(|key| (key, &census.types[key]))
                .collect(),
            undeclared: &census.undeclared,
            unjudged_imports: line(census.unjudged_imports),
            lines,
            report_json: demlik_code_graph::boundaries::render::render_boundaries(
                &[],
                &".".into(),
                Censuses {
                    libraries: Some(census),
                    deployables: None,
                },
                true,
                false,
            )?,
        })
    } else {
        None
    };
    Ok(serde_json::to_string(&Frame {
        id: &request.id,
        output,
        observed_calls: calls,
    })?)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::args()
        .nth(1)
        .ok_or("native fixture root required")?;
    for input in io::stdin().lock().lines() {
        let input: Request = serde_json::from_str(&input?)?;
        let output = match input.mode.as_str() {
            "deployable" => deployable(&input)?,
            "library" | "library-disabled" => library(&input, Path::new(&root))?,
            _ => return Err("unknown probe mode".into()),
        };
        println!("{output}");
    }
    Ok(())
}
