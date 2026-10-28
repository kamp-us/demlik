use demlik_code_graph::{
    engine::tsgo::TsgoBinary,
    extract::{assemble::NodeFields, directories::build_directories},
    project::{Collation, EdgeScope, load_cheap_project, load_edge_project},
    schema::{
        CallerSite, DirectoryNode, Edges, FunctionKind, FunctionNode, Graph, Health, ModuleNode,
        Provenance, ReachabilityReport, Smell, SmellKind, SmellTarget, Stats, Summary, Thresholds,
        WithheldReason, WithheldSymbol,
    },
    smells::{coupling::CouplingFacts, plan::PlanAxis},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    error::Error,
    io::{self, BufRead},
    path::PathBuf,
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
macro_rules! observe {
    ($calls:expr, $function:path $(, $arg:expr)* $(,)?) => {{
        $calls.push(stringify!($function));
        $function($($arg),*)
    }};
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    input: Value,
    root: PathBuf,
}
fn text<'a>(v: &'a Value, key: &str, default: &'a str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or(default)
}
fn number(v: &Value, key: &str, default: usize) -> usize {
    v.get(key)
        .and_then(Value::as_u64)
        .map_or(default, |n| n as usize)
}
fn list<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}
fn kind(word: &str) -> Result<SmellKind> {
    Ok(serde_json::from_value(json!(word))?)
}
fn smell(v: &Value) -> Result<Smell> {
    let t = &v["target"];
    let target = match text(t, "type", "function") {
        "function" => SmellTarget::Function {
            id: text(t, "id", "same").into(),
            file: text(t, "file", "same.ts").into(),
            start_line: number(t, "startLine", 1),
        },
        "module" => SmellTarget::Module {
            file: text(t, "file", "same.ts").into(),
        },
        "directory" => SmellTarget::Directory {
            dir: text(t, "dir", ".").into(),
        },
        other => return Err(format!("unknown fixture target {other}").into()),
    };
    Ok(Smell {
        kind: kind(text(v, "kind", "long-function"))?,
        target,
        value: number(v, "value", 1),
        threshold: number(v, "threshold", 1) as u64,
        severity: serde_json::from_value(v.get("severity").cloned().unwrap_or(json!("warn")))?,
    })
}
fn function(v: &Value) -> Result<FunctionNode> {
    let id = text(v, "id", "f");
    let edges = v.get("edges").filter(|v| !v.is_null()).map(|e| Edges {
        calls: vec![],
        called_by: list(e, "calledBy")
            .iter()
            .map(|c| CallerSite {
                caller_id: text(c, "callerId", "").into(),
                line: number(c, "line", 1),
            })
            .collect(),
        call_chain_depth: number(e, "callChainDepth", 0),
    });
    Ok(FunctionNode {
        id: id.into(),
        name: text(v, "name", id.rsplit(':').next().unwrap_or(id)).into(),
        kind: FunctionKind::Function,
        file: text(v, "file", "one.ts").into(),
        start_line: number(v, "startLine", 1),
        end_line: number(v, "endLine", 1),
        loc: number(v, "loc", 1),
        comment_lines: number(v, "commentLines", 0),
        nesting_depth: number(v, "nestingDepth", 0),
        complexity: number(v, "complexity", 1),
        is_exported: v.get("isExported").and_then(Value::as_bool).unwrap_or(true),
        is_test: v.get("isTest").and_then(Value::as_bool).unwrap_or(false),
        edges,
        node_kind: None,
        smells: list(v, "smells").iter().map(smell).collect::<Result<_>>()?,
        header: None,
    })
}
fn module(v: &Value) -> Result<ModuleNode> {
    Ok(ModuleNode {
        file: text(v, "file", "one.ts").into(),
        loc: number(v, "loc", 1),
        comment_lines: number(v, "commentLines", 0),
        function_ids: list(v, "functionIds")
            .iter()
            .map(|s| s.as_str().unwrap().into())
            .collect(),
        imports: vec![],
        imported_by: vec![],
        import_edges: vec![],
        is_test: false,
        smells: list(v, "smells").iter().map(smell).collect::<Result<_>>()?,
    })
}
fn graph(input: &Value, collation: &Collation) -> Result<Graph> {
    let functions: Vec<_> = list(input, "functions")
        .iter()
        .map(function)
        .collect::<Result<_>>()?;
    let modules: Vec<_> = list(input, "modules")
        .iter()
        .map(module)
        .collect::<Result<_>>()?;
    let thresholds: Thresholds =
        serde_json::from_value(input.get("thresholds").cloned().unwrap_or(json!({})))?;
    let directories = build_directories(&modules, &thresholds, collation)?;
    let smells = functions
        .iter()
        .flat_map(|f| f.smells.iter().cloned())
        .collect::<Vec<_>>();
    Ok(Graph {
        root: "authored".into(),
        provenance: Provenance::Cheap,
        thresholds,
        summary: Summary {
            health: Health::Rough,
            file_count: modules.len(),
            function_count: functions.len(),
            smell_count: smells.len(),
            high_severity_count: 0,
            worst_file: None,
            worst_function: None,
            top_targets: vec![],
            parse_failures: vec![],
        },
        cross_runtime: None,
        reachability: None,
        clusters: None,
        interface_width: None,
        data: None,
        functions,
        declarations: vec![],
        modules,
        directories,
        smells,
        stats: Stats {
            file_count: list(input, "modules").len(),
            function_count: list(input, "functions").len(),
            total_loc: 0,
            total_comment_lines: 0,
            smell_count: 0,
            parse_failures: vec![],
        },
    })
}
fn views(
    g: &Graph,
    axis: PlanAxis,
    collation: &Collation,
    calls: &mut Vec<&'static str>,
) -> Result<Value> {
    Ok(json!({
        "rows": observe!(calls, demlik_code_graph::smells::plan::rank_plan, &g.functions, axis, collation)?,
        "text": observe!(calls, demlik_code_graph::render::plan::render_plan, g, axis, false, false, collation)?,
        "json": observe!(calls, demlik_code_graph::render::plan::render_plan, g, axis, true, false, collation)?,
        "pretty": observe!(calls, demlik_code_graph::render::plan::render_plan, g, axis, true, true, collation)?,
    }))
}
fn empty_reach() -> ReachabilityReport {
    ReachabilityReport {
        entry_count: 0,
        exported_count: 0,
        reachable_count: 0,
        unreachable: vec![],
        withheld: vec![],
        unguarded: vec![],
    }
}
fn reason(word: &str) -> WithheldReason {
    match word {
        "referenced-in-non-test-file" => WithheldReason::ReferencedInNonTestFile,
        "public-entry-surface" => WithheldReason::PublicEntrySurface,
        "test-support-surface" => WithheldReason::TestSupportSurface,
        _ => unreachable!("frozen three-word reason fixture"),
    }
}
fn permutations(values: &[String]) -> Vec<Vec<String>> {
    if values.is_empty() {
        return vec![vec![]];
    }
    values
        .iter()
        .enumerate()
        .flat_map(|(i, v)| {
            let rest: Vec<_> = values
                .iter()
                .enumerate()
                .filter(|(j, _)| i != *j)
                .map(|(_, v)| v.clone())
                .collect();
            permutations(&rest).into_iter().map(move |mut tail| {
                tail.insert(0, v.clone());
                tail
            })
        })
        .collect()
}
fn execute(request: Request, compiler: &TsgoBinary) -> Result<(Value, Vec<&'static str>)> {
    let input = request.input;
    let collation = Collation::try_node22_en_us()?;
    let mut calls = vec![];
    let thresholds = serde_json::from_value(input.get("thresholds").cloned().unwrap_or(json!({})))?;
    let output = match text(&input, "mode", "") {
        "kind-matrix" => {
            let words = list(&input, "words");
            let mut rows = vec![];
            for left in words {
                for right in words {
                    let a = smell(&json!({"kind":left}))?;
                    let b = smell(&json!({"kind":right}))?;
                    let ordering = observe!(
                        calls,
                        demlik_code_graph::smells::evaluate::compare_flat_smells,
                        &a,
                        &b,
                        &collation
                    )?;
                    rows.push(json!({"left":left,"right":right,"result":ordering as i8}));
                }
            }
            json!(rows)
        }
        "tally" => {
            let reasons: Vec<_> = list(&input, "reasons")
                .iter()
                .map(|s| s.as_str().unwrap().to_owned())
                .collect();
            let mut output = vec![];
            for order in permutations(&reasons) {
                let mut g = graph(&json!({}), &collation)?;
                let mut reach = empty_reach();
                for word in &order {
                    for i in 0..=reasons.iter().position(|r| r == word).unwrap() {
                        reach.withheld.push(WithheldSymbol {
                            id: format!("{word}.{i}"),
                            reason: reason(word),
                        });
                    }
                }
                g.reachability = Some(reach);
                output.push(json!({"order":order,
                    "text":observe!(calls, demlik_code_graph::render::analysis::render_unreachable, &g, false, false)?,
                    "json":observe!(calls, demlik_code_graph::render::analysis::render_unreachable, &g, true, false)?,
                    "pretty":observe!(calls, demlik_code_graph::render::analysis::render_unreachable, &g, true, true)?,
                }));
            }
            json!(output)
        }
        "function" => {
            let mut out = vec![];
            for f in list(&input, "functions") {
                out.push(observe!(
                    calls,
                    demlik_code_graph::smells::evaluate::smells_for_function,
                    &function(f)?,
                    &thresholds
                ));
            }
            json!(out)
        }
        "module" => {
            let mut out = vec![];
            for (i, m) in list(&input, "modules").iter().enumerate() {
                let facts =
                    input["coupling"]
                        .get(i)
                        .filter(|v| !v.is_null())
                        .map(|v| CouplingFacts {
                            boundary: String::new(),
                            cycle_size: number(v, "cycleSize", 0),
                            cross_boundary_out_count: number(v, "crossBoundaryOutCount", 0),
                        });
                out.push(observe!(
                    calls,
                    demlik_code_graph::smells::evaluate::smells_for_module,
                    &module(m)?,
                    &thresholds,
                    facts.as_ref()
                ));
            }
            json!(out)
        }
        "directory" => {
            let mut out = vec![];
            for d in list(&input, "directories") {
                let node = DirectoryNode {
                    dir: text(d, "dir", ".").into(),
                    file_count: number(d, "fileCount", 0),
                    function_count: 0,
                    files: vec![],
                    smells: vec![],
                };
                out.push(observe!(
                    calls,
                    demlik_code_graph::smells::evaluate::smells_for_directory,
                    &node,
                    &thresholds
                ));
            }
            json!(out)
        }
        "flat" => {
            let smells: Vec<_> = list(&input, "smells")
                .iter()
                .map(smell)
                .collect::<Result<_>>()?;
            // This finite public-comparator consumer prepares all fallible results before sorting.
            let mut comparisons = vec![];
            for left in &smells {
                let mut row = vec![];
                for right in &smells {
                    row.push(observe!(
                        calls,
                        demlik_code_graph::smells::evaluate::compare_flat_smells,
                        left,
                        right,
                        &collation
                    )?);
                }
                comparisons.push(row);
            }
            let mut rows: Vec<_> = smells.into_iter().enumerate().collect();
            rows.sort_by(|a, b| comparisons[a.0][b.0]);
            json!(rows.into_iter().map(|(_, s)| s).collect::<Vec<_>>())
        }
        "plan" | "render-plan" => {
            let g = graph(&input, &collation)?;
            let before = serde_json::to_vec(&g.functions)?;
            let out = views(
                &g,
                PlanAxis::parse(text(&input, "axis", "rot")).unwrap(),
                &collation,
                &mut calls,
            )?;
            assert_eq!(before, serde_json::to_vec(&g.functions)?);
            out
        }
        "empty" => {
            let mut g = graph(&json!({}), &collation)?;
            let plans = views(&g, PlanAxis::Rot, &collation, &mut calls)?;
            let no_pass = observe!(
                calls,
                demlik_code_graph::render::analysis::render_unreachable,
                &g,
                false,
                false
            )?;
            g.reachability = Some(empty_reach());
            json!({"plans":plans,"noPass":no_pass,
                "emptyText":observe!(calls, demlik_code_graph::render::analysis::render_unreachable, &g, false, false)?,
                "emptyJson":observe!(calls, demlik_code_graph::render::analysis::render_unreachable, &g, true, true)?,
            })
        }
        "html" => {
            let g = graph(&input, &collation)?;
            let model = observe!(
                calls,
                demlik_code_graph::render::html::build_html_model,
                &g,
                &collation
            )?;
            assert!(std::ptr::eq(model.summary, &g.summary));
            serde_json::to_value(model)?
        }
        "cheap" | "go" => {
            let deep = text(&input, "mode", "") == "go";
            let g = if deep {
                let loaded =
                    load_edge_project(&request.root, EdgeScope::Deep, &request.root, None)?;
                observe!(
                    calls,
                    demlik_code_graph::extract::assemble::assemble_graph_with_edges,
                    &loaded,
                    thresholds,
                    compiler,
                    NodeFields::default(),
                    &collation
                )?
            } else {
                let loaded = load_cheap_project(&request.root, None)?;
                observe!(
                    calls,
                    demlik_code_graph::extract::assemble::assemble_graph,
                    &loaded,
                    thresholds,
                    NodeFields::default(),
                    &collation
                )?
            };
            assert!(g.modules.len() > 2 && !g.smells.is_empty());
            let plan = views(
                &g,
                if deep {
                    PlanAxis::Impact
                } else {
                    PlanAxis::Rot
                },
                &collation,
                &mut calls,
            )?;
            json!({"graph":g,"plan":plan})
        }
        other => return Err(format!("unknown fixture mode {other}").into()),
    };
    Ok((output, calls))
}
fn main() -> Result<()> {
    let compiler = TsgoBinary::from_native_preview_manifest(&PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("compiler manifest required")?,
    ))?;
    for line in io::stdin().lock().lines() {
        let input = line?;
        let result = serde_json::from_str::<Request>(&input)
            .map_err(Into::into)
            .and_then(|r| execute(r, &compiler));
        let output = match result {
            Ok((output, calls)) => json!({"ok":true,"output":output,"observedCalls":calls}),
            Err(error) => json!({"ok":false,"error":error.to_string(),"observedCalls":[]}),
        };
        println!("{}", serde_json::to_string(&output)?);
    }
    Ok(())
}
