use demlik_code_graph::{
    boundaries::{
        libraries::{LibrariesRead, read_libraries},
        rules::{BoundaryRules, Place, ZoneName, place_of, scope_zoning},
        shape::{
            ShapeRead,
            application::{ApplicationFile, ApplicationWorld, application_violations},
            judge::{ShapeContext, ShapedFile, judge_shape},
            read_shape, shape_facts_of,
        },
        violation::BoundaryViolation,
    },
    extract::wrangler_config::load_binding_catalog,
    project::{EdgeScope, load_edge_project},
    syntax::imports::{ImportEdge, ImportKind, resolve_imports, runtime_specifiers},
    text::{JsString, JsValue},
};
use indexmap::IndexSet;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::{
    io::{self, BufRead},
    path::Path,
};
macro_rules! observe {
    ($calls:expr, $function:path $(, $argument:expr)* $(,)?) => {{
        let result=$function($($argument),*);
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
    repo_root: String,
    rules: Box<RawValue>,
    scope: JsString,
    file: JsString,
    facts: Box<RawValue>,
    action: Box<RawValue>,
    judged: Vec<JudgedInput>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EdgeInput {
    specifier: JsString,
    kind: ImportKind,
    type_only: bool,
    target: Box<RawValue>,
}
#[derive(Deserialize)]
struct Tag {
    kind: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DiskInput {
    #[serde(rename = "kind")]
    _kind: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpaqueInput {
    #[serde(rename = "kind")]
    _kind: String,
    edges: Vec<EdgeInput>,
    runtime_specifiers: IndexSet<JsString>,
    offending_form: Box<RawValue>,
}
struct Facts {
    edges: Vec<ImportEdge>,
    runtime: IndexSet<JsString>,
    form: Option<JsString>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplicationInput {
    #[serde(rename = "kind")]
    _kind: String,
    feature: JsString,
    own: Vec<ZoneName>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JudgeInput {
    #[serde(rename = "kind")]
    _kind: String,
    place_file: JsString,
}
enum Action {
    Application(ApplicationInput),
    Judge(JudgeInput),
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum JudgedInput {
    Original { index: usize },
    Copy { index: usize },
}
fn decode<T: serde::de::DeserializeOwned>(raw: &RawValue) -> Result<T, String> {
    serde_json::from_str(raw.get()).map_err(|error| error.to_string())
}
fn json(value: &impl Serialize) -> Result<Box<RawValue>, String> {
    RawValue::from_string(serde_json::to_string(value).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}
#[derive(Serialize)]
struct Thrown {
    name: &'static str,
    message: JsString,
}
fn execute(request: &Request, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, String> {
    let metadata_collation = demlik_code_graph::project::Collation::try_node22_en_us()
        .map_err(|error| error.to_string())?;

    if request.operation != "code_graph.shape-judgment" {
        return Err("unsupported operation".into());
    }
    let input: Input = decode(&request.input)?;
    let action = match decode::<Tag>(&input.action)?.kind.as_str() {
        "application" => Action::Application(decode(&input.action)?),
        "judge" => Action::Judge(decode(&input.action)?),
        _ => return Err("unknown action kind".into()),
    };
    let facts = match decode::<Tag>(&input.facts)?.kind.as_str() {
        "disk" => {
            let _: DiskInput = decode(&input.facts)?;
            None
        }
        "opaque" => {
            let facts: OpaqueInput = decode(&input.facts)?;
            let form = decode::<Option<JsString>>(&facts.offending_form)?;
            let edges = facts
                .edges
                .into_iter()
                .map(|edge| {
                    Ok(ImportEdge {
                        specifier: edge.specifier,
                        kind: edge.kind,
                        type_only: edge.type_only,
                        target: decode(&edge.target)?,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            for judged in &input.judged {
                let (JudgedInput::Original { index } | JudgedInput::Copy { index }) = judged;
                if *index >= edges.len() {
                    return Err("judged index does not name an import edge".into());
                }
            }
            Some(Facts {
                edges,
                runtime: facts.runtime_specifiers,
                form,
            })
        }
        _ => return Err("unknown facts kind".into()),
    };
    let rules = observe!(
        calls,
        BoundaryRules::parse,
        &JsValue::parse(input.rules.get()).map_err(|error| error.to_string())?
    )
    .map_err(|error| error.to_string())?;
    let root = Path::new(&input.repo_root);
    let catalog = observe!(calls, load_binding_catalog, root, None, &metadata_collation)
        .map_err(|error| error.to_string())?;
    let shape = match observe!(calls, read_shape, &rules, &catalog) {
        Ok(ShapeRead::Read(shape)) => shape,
        Ok(ShapeRead::Refused { message }) => {
            #[derive(Serialize)]
            struct Refused {
                kind: &'static str,
                message: JsString,
            }
            return json(&Refused {
                kind: "refused",
                message,
            });
        }
        Err(error) => {
            return json(&Thrown {
                name: "Error",
                message: error.to_string().into(),
            });
        }
    };
    let libraries = match observe!(
        calls,
        read_libraries,
        &rules,
        root,
        None,
        &metadata_collation
    )
    .map_err(|error| error.to_string())?
    {
        LibrariesRead::Read(libraries) => libraries,
        LibrariesRead::Refused { message } => return Err(message.to_lossy()),
    };
    let zoning = match observe!(calls, scope_zoning, &rules, &input.scope) {
        Ok(zoning) => zoning,
        Err(error) => {
            return json(&Thrown {
                name: "TypeError",
                message: error.to_string().into(),
            });
        }
    };
    let facts = match facts {
        Some(facts) => facts,
        None => {
            let absolute = if input.scope == "." {
                root.to_path_buf()
            } else {
                root.join(input.scope.to_lossy())
            };
            let loaded = observe!(
                calls,
                load_edge_project,
                &absolute,
                EdgeScope::Package,
                root,
                None,
                &metadata_collation
            )
            .map_err(|error| error.to_string())?;
            let unit = loaded
                .project
                .source_files
                .iter()
                .find(|unit| input.file == unit.file)
                .ok_or_else(|| "file is not a loaded source file".to_owned())?;
            let graph = observe!(
                calls,
                resolve_imports,
                &absolute,
                &loaded.project.source_files,
                &loaded.ts_config_path,
                &metadata_collation
            )
            .map_err(|error| error.to_string())?;
            let facts = observe!(
                calls,
                shape_facts_of,
                &shape,
                &input.scope,
                &input.file,
                &unit.syntax
            );
            Facts {
                edges: graph
                    .import_edges_by_file
                    .get(&unit.file)
                    .cloned()
                    .unwrap_or_default(),
                runtime: runtime_specifiers(&unit.syntax),
                form: facts.offending_form,
            }
        }
    };
    let mut copies = Vec::new();
    for judged in &input.judged {
        let (JudgedInput::Original { index } | JudgedInput::Copy { index }) = judged;
        if *index >= facts.edges.len() {
            return Err("judged index does not name an import edge".into());
        }
        if matches!(judged, JudgedInput::Copy { .. }) {
            copies.push(facts.edges[*index].clone());
        }
    }
    let mut next_copy = 0;
    let judged: Vec<_> = input
        .judged
        .iter()
        .map(|judged| match judged {
            JudgedInput::Original { index } => &facts.edges[*index],
            JudgedInput::Copy { .. } => {
                let copy = &copies[next_copy];
                next_copy += 1;
                copy
            }
        })
        .collect();
    let found = match action {
        Action::Application(action) => observe!(
            calls,
            application_violations,
            ApplicationFile {
                scope: &input.scope,
                file: &input.file,
                feature: &action.feature,
                own: &action.own,
                import_edges: &facts.edges,
                runtime_specifiers: &facts.runtime,
                judged: &judged
            },
            ApplicationWorld {
                rules: &shape,
                libraries: &libraries,
                place_of: &|target| place_of(target, &zoning)
            }
        ),
        Action::Judge(action) => {
            let place: Place = observe!(calls, place_of, &action.place_file, &zoning);
            observe!(
                calls,
                judge_shape,
                ShapeContext {
                    scope: &input.scope,
                    shape: &shape,
                    libraries: &libraries,
                    zoning: &zoning
                },
                ShapedFile {
                    file: &input.file,
                    import_edges: &facts.edges,
                    runtime_specifiers: &facts.runtime,
                    offending_form: facts.form.as_ref()
                },
                &place,
                &judged
            )
        }
    };
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Output<'a> {
        edges: &'a [ImportEdge],
        runtime_specifiers: &'a IndexSet<JsString>,
        offending_form: Option<&'a JsString>,
        violations: Vec<BoundaryViolation>,
    }
    json(&Output {
        edges: &facts.edges,
        runtime_specifiers: &facts.runtime,
        offending_form: facts.form.as_ref(),
        violations: found,
    })
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let request = serde_json::from_str::<Request>(&line?);
        let id = request.as_ref().ok().map(|request| request.id.clone());
        let mut observed_calls = Vec::new();
        let result = request
            .map_err(|error| error.to_string())
            .and_then(|request| execute(&request, &mut observed_calls));
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
            output: Option<Box<RawValue>>,
            #[serde(skip_serializing_if = "Option::is_none")]
            error: Option<DriverError>,
            observed_calls: Vec<&'static str>,
        }
        let (ok, output, error) = match result {
            Ok(output) => (true, Some(output), None),
            Err(message) => (
                false,
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
                ok,
                output,
                error,
                observed_calls
            })?
        );
    }
    Ok(())
}
