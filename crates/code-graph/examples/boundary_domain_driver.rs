use demlik_code_graph::{
    boundaries::{
        config::BoundaryRuleInputError,
        declaration::DeclarationError,
        impure::{GLOBAL_OBJECT, IMPURE_GLOBALS, ImpureShape},
        impure_uses::{ImpureFacts, ImpureUse},
        rules::Place,
        violation::BoundaryViolation,
        zones::impure_violations::{ImpureContext, ImpureFile},
    },
    syntax::imports::ImportEdge,
    text::{JsString, JsValue},
    validation::{InputIssue, RecordTypeError},
};
use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::io::{self, BufRead};
use std::path::Path;

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
#[serde(deny_unknown_fields)]
struct ImpureInput {
    paths: Vec<Vec<JsString>>,
    ctors: Vec<JsString>,
    edges: Vec<ImportEdge>,
    runtime: IndexSet<JsString>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImpureUsesInput {
    file: String,
    source: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct OpeningInput {
    file: JsString,
    import_edges: Vec<ImportEdge>,
    runtime_specifiers: IndexSet<JsString>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RootReachInput {
    scope: JsString,
    globs: Vec<JsString>,
    files: Vec<OpeningInput>,
    tests: Vec<usize>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RootReachOutput<'a> {
    roots: &'a IndexSet<JsString>,
    in_reach: &'a IndexSet<JsString>,
    violations: Vec<Vec<BoundaryViolation>>,
    same_empty: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ZoneImpurityInput {
    scope: JsString,
    file: JsString,
    source: String,
    rules: Box<RawValue>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TestRoleInput {
    scope: JsString,
    file: JsString,
    patterns: Vec<JsString>,
    violations: Vec<BoundaryViolation>,
}
#[derive(Serialize)]
struct ZoneImpurityOutput {
    place: Place,
    violations: Vec<BoundaryViolation>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TestRoleOutput<'a> {
    matches: bool,
    is_test: bool,
    judged: Vec<&'a BoundaryViolation>,
    same_refs: Vec<usize>,
}
#[derive(Serialize)]
struct ImpureUsesOutput {
    uses: Vec<ImpureUse>,
    names: Vec<JsString>,
    runtime: Vec<JsString>,
}
#[derive(Serialize)]
#[serde(untagged)]
enum Check {
    Issue { issue: Option<JsString> },
    Thrown { thrown: Thrown },
}
#[derive(Serialize)]
struct Thrown {
    name: &'static str,
    message: JsString,
}
fn checked(result: Result<Option<JsString>, DeclarationError>) -> Check {
    match result {
        Ok(issue) => Check::Issue { issue },
        Err(error) => Check::Thrown {
            thrown: Thrown {
                name: error.name(),
                message: error.message(),
            },
        },
    }
}
#[derive(Serialize)]
struct Declarations {
    library: Check,
    deployable: Check,
    shape: Check,
    combined: Check,
}
#[derive(Serialize)]
#[serde(untagged, rename_all = "camelCase")]
enum InputRefusal {
    Issue {
        #[serde(rename = "inputIssue")]
        input_issue: InputIssue,
    },
    Thrown {
        thrown: RecordTypeError,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImpureOutput {
    paths: Vec<Option<JsString>>,
    ctors: Vec<Option<JsString>>,
    modules: Vec<Option<JsString>>,
    opened: Vec<JsString>,
    rows: Vec<&'static str>,
    globals: IndexMap<&'static str, ImpureShape>,
    global_object: &'static str,
}
fn json(value: &impl Serialize) -> Result<Box<RawValue>, String> {
    RawValue::from_string(serde_json::to_string(value).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}
fn execute(request: &Request, calls: &mut Vec<&'static str>) -> Result<Box<RawValue>, String> {
    let metadata_collation = demlik_code_graph::project::Collation::try_node22_en_us()
        .map_err(|error| error.to_string())?;
    match request.operation.as_str() {
        "code_graph.test-reach" => {
            use demlik_code_graph::boundaries::zones::test_reach::{
                OpeningFile, root_reach_of, test_reach_violations,
            };
            let input: RootReachInput =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            let patterns = input
                .globs
                .iter()
                .map(demlik_code_graph::kinds::glob::glob_to_regexp)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            let files: Vec<_> = input
                .files
                .iter()
                .map(|file| OpeningFile {
                    file: &file.file,
                    import_edges: &file.import_edges,
                    runtime_specifiers: &file.runtime_specifiers,
                })
                .collect();
            let reach = observe!(calls, root_reach_of, &patterns, &input.scope, &files);
            let empty = observe!(calls, root_reach_of, &[], &input.scope, &[]);
            let mut violations = Vec::new();
            for index in input.tests {
                let file = files.get(index).ok_or("test index outside the file list")?;
                violations.push(observe!(
                    calls,
                    test_reach_violations,
                    &reach,
                    &input.scope,
                    file
                ));
            }
            json(&RootReachOutput {
                roots: &reach.roots,
                in_reach: &reach.in_reach,
                violations,
                same_empty: std::sync::Arc::ptr_eq(&reach, &empty),
            })
        }
        "code_graph.entry-form" => {
            let input: ImpureUsesInput =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            let syntax = observe!(
                calls,
                demlik_code_graph::engine::oxc::parse_type_script,
                Path::new(&input.file),
                &input.source
            )
            .map_err(|error| error.to_string())?;
            json(&observe!(
                calls,
                demlik_code_graph::boundaries::shape::entry_file::first_offending_form,
                &syntax
            ))
        }
        "code_graph.zone-impurity" => {
            let input: ZoneImpurityInput =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            let value = JsValue::parse(input.rules.get()).map_err(|error| error.to_string())?;
            let rules = match observe!(
                calls,
                demlik_code_graph::boundaries::rules::BoundaryRules::parse,
                &value
            ) {
                Ok(rules) => rules,
                Err(BoundaryRuleInputError::Issue(input_issue)) => {
                    return json(&InputRefusal::Issue { input_issue });
                }
                Err(BoundaryRuleInputError::TypeError(thrown)) => {
                    return json(&InputRefusal::Thrown { thrown });
                }
            };
            let zoning = match observe!(
                calls,
                demlik_code_graph::boundaries::rules::scope_zoning,
                &rules,
                &input.scope
            ) {
                Ok(zoning) => zoning,
                Err(error) => {
                    return json(&Check::Thrown {
                        thrown: Thrown {
                            name: "TypeError",
                            message: error.to_string().into(),
                        },
                    });
                }
            };
            let place = observe!(
                calls,
                demlik_code_graph::boundaries::rules::place_of,
                &input.file,
                &zoning
            );
            let syntax = observe!(
                calls,
                demlik_code_graph::engine::oxc::parse_type_script,
                Path::new(&input.file.to_lossy()),
                &input.source
            )
            .map_err(|error| error.to_string())?;
            let uses = observe!(
                calls,
                demlik_code_graph::boundaries::impure_uses::detect_impure_uses,
                &syntax,
                &metadata_collation
            )
            .map_err(|error| error.to_string())?;
            let edges: Vec<_> = observe!(
                calls,
                demlik_code_graph::syntax::imports::import_literals,
                &syntax
            )
            .into_iter()
            .map(|literal| ImportEdge {
                specifier: literal.specifier,
                kind: literal.kind,
                type_only: literal.type_only,
                target: None,
            })
            .collect();
            let runtime = observe!(
                calls,
                demlik_code_graph::syntax::imports::runtime_specifiers,
                &syntax
            );
            let violations = observe!(
                calls,
                demlik_code_graph::boundaries::zones::impure_violations::impure_violations,
                ImpureContext {
                    scope: &input.scope,
                    module: ImpureFile {
                        file: &input.file,
                        facts: ImpureFacts {
                            impure_uses: &uses,
                            import_edges: &edges,
                            runtime_specifiers: &runtime
                        }
                    },
                    place: &place
                }
            );
            json(&ZoneImpurityOutput { place, violations })
        }
        "code_graph.test-role" => {
            let input: TestRoleInput =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            let globs = input
                .patterns
                .iter()
                .map(|pattern| {
                    observe!(
                        calls,
                        demlik_code_graph::kinds::glob::glob_to_regexp,
                        pattern
                    )
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            let matches = observe!(
                calls,
                demlik_code_graph::boundaries::zones::test_role::matches_globs,
                &globs,
                &input.scope,
                &input.file
            );
            let is_test = observe!(
                calls,
                demlik_code_graph::boundaries::zones::test_role::is_test_file,
                &globs,
                &input.scope,
                &input.file
            );
            let judged = observe!(
                calls,
                demlik_code_graph::boundaries::zones::test_role::judged_in_test_file,
                &input.violations
            );
            let same_refs = judged
                .iter()
                .map(|item| {
                    input
                        .violations
                        .iter()
                        .position(|candidate| std::ptr::eq(*item, candidate))
                        .expect("filtered violations borrow their input")
                })
                .collect();
            json(&TestRoleOutput {
                matches,
                is_test,
                judged,
                same_refs,
            })
        }
        "code_graph.impure-uses" => {
            let input: ImpureUsesInput =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            let syntax = observe!(
                calls,
                demlik_code_graph::engine::oxc::parse_type_script,
                Path::new(&input.file),
                &input.source
            )
            .map_err(|error| error.to_string())?;
            let literals = observe!(
                calls,
                demlik_code_graph::syntax::imports::import_literals,
                &syntax
            );
            let edges: Vec<_> = literals
                .into_iter()
                .map(|literal| ImportEdge {
                    specifier: literal.specifier,
                    kind: literal.kind,
                    type_only: literal.type_only,
                    target: None,
                })
                .collect();
            let runtime = observe!(
                calls,
                demlik_code_graph::syntax::imports::runtime_specifiers,
                &syntax
            );
            let uses = observe!(
                calls,
                demlik_code_graph::boundaries::impure_uses::detect_impure_uses,
                &syntax,
                &metadata_collation
            )
            .map_err(|error| error.to_string())?;
            let names = observe!(
                calls,
                demlik_code_graph::boundaries::impure_uses::impure_names_of,
                ImpureFacts {
                    impure_uses: &uses,
                    import_edges: &edges,
                    runtime_specifiers: &runtime
                }
            );
            json(&ImpureUsesOutput {
                uses,
                names,
                runtime: runtime.into_iter().collect(),
            })
        }
        "code_graph.boundary-declarations" => {
            let value = JsValue::parse(request.input.get()).map_err(|error| error.to_string())?;
            let parsed = observe!(
                calls,
                demlik_code_graph::boundaries::rules::BoundaryRules::parse,
                &value
            );
            let rules = match parsed {
                Ok(rules) => rules,
                Err(BoundaryRuleInputError::Issue(input_issue)) => {
                    return json(&InputRefusal::Issue { input_issue });
                }
                Err(BoundaryRuleInputError::TypeError(thrown)) => {
                    return json(&InputRefusal::Thrown { thrown });
                }
            };
            let output = Declarations {
                library: checked(observe!(
                    calls,
                    demlik_code_graph::boundaries::declaration::library_declaration_issue,
                    &rules
                )),
                deployable: checked(observe!(
                    calls,
                    demlik_code_graph::boundaries::declaration::deployable_declaration_issue,
                    &rules
                )),
                shape: checked(observe!(
                    calls,
                    demlik_code_graph::boundaries::declaration::shape_declaration_issue,
                    &rules
                )),
                combined: checked(observe!(
                    calls,
                    demlik_code_graph::boundaries::declaration::declaration_issue,
                    &rules
                )),
            };
            json(&output)
        }
        "code_graph.impure" => {
            let input: ImpureInput =
                serde_json::from_str(request.input.get()).map_err(|error| error.to_string())?;
            let paths: Vec<_> = input
                .paths
                .iter()
                .map(|path| {
                    observe!(
                        calls,
                        demlik_code_graph::boundaries::impure::impure_path_of,
                        path
                    )
                })
                .collect();
            let ctors: Vec<_> = input
                .ctors
                .iter()
                .map(|ctor| {
                    observe!(
                        calls,
                        demlik_code_graph::boundaries::impure::impure_bare_new_of,
                        ctor
                    )
                })
                .collect();
            let modules: Vec<_> = input
                .edges
                .iter()
                .map(|edge| {
                    observe!(
                        calls,
                        demlik_code_graph::boundaries::impure::impure_module_of,
                        edge
                    )
                })
                .collect();
            let opened = observe!(
                calls,
                demlik_code_graph::boundaries::impure::impure_modules_opened,
                &input.edges,
                &input.runtime
            );
            let rows: Vec<_> =
                observe!(calls, demlik_code_graph::boundaries::impure::impure_rows).collect();
            let globals: IndexMap<_, _> = IMPURE_GLOBALS
                .iter()
                .map(|row| (row.name, row.shape))
                .collect();
            calls.push("demlik_code_graph::boundaries::impure::IMPURE_GLOBALS");
            calls.push("demlik_code_graph::boundaries::impure::GLOBAL_OBJECT");
            json(&ImpureOutput {
                paths,
                ctors,
                modules,
                opened,
                rows,
                globals,
                global_object: GLOBAL_OBJECT,
            })
        }
        _ => Err("unsupported operation".into()),
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
    error: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostic: Option<String>,
    observed_calls: Vec<&'static str>,
}
fn main() -> io::Result<()> {
    for line in io::stdin().lock().lines() {
        let line = line?;
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
    Ok(())
}
