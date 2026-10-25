use demlik_code_graph::{
    boundaries::zones::test_reach::{OpeningFile, root_reach_of, test_reach_violations},
    engine::oxc::parse_type_script,
    kinds::glob::glob_to_regexp,
    syntax::imports::{ImportEdge, import_literals, runtime_specifiers},
    text::JsString,
};
use indexmap::IndexSet;
use std::{path::Path, sync::Arc};

struct File {
    name: JsString,
    edges: Vec<ImportEdge>,
    runtime: IndexSet<JsString>,
}
impl File {
    fn new(name: &str, source: &str, target: Option<&str>) -> Self {
        let syntax = parse_type_script(Path::new(name), source).unwrap();
        Self {
            name: name.into(),
            edges: import_literals(&syntax)
                .into_iter()
                .map(|literal| ImportEdge {
                    specifier: literal.specifier,
                    kind: literal.kind,
                    type_only: literal.type_only,
                    target: target.map(Into::into),
                })
                .collect(),
            runtime: runtime_specifiers(&syntax),
        }
    }
    fn opening(&self) -> OpeningFile<'_> {
        OpeningFile {
            file: &self.name,
            import_edges: &self.edges,
            runtime_specifiers: &self.runtime,
        }
    }
}

#[test]
fn a_test_reports_its_first_hop_toward_the_app_and_stops_when_the_helper_is_repaired() {
    let scope = "services/shop".into();
    let root = File::new("src/main.ts", "export const app = 1", None);
    let server = File::new(
        "src/server.ts",
        "export { app } from './main'",
        Some("src/main.ts"),
    );
    let test = File::new("src/a.test.ts", "import './server'", Some("src/server.ts"));
    let only_types = File::new(
        "src/types.test.ts",
        "import {type App} from './server'",
        Some("src/server.ts"),
    );
    let globs = [glob_to_regexp(&"src/main.ts".into()).unwrap()];
    let reach = root_reach_of(
        &globs,
        &scope,
        &[
            root.opening(),
            server.opening(),
            test.opening(),
            only_types.opening(),
        ],
    );
    assert!(reach.in_reach.contains(&test.name));
    assert!(!reach.in_reach.contains(&only_types.name));
    let rows = test_reach_violations(&reach, &scope, &test.opening());
    assert_eq!(
        serde_json::to_value(rows).unwrap()[0]["to"],
        "services/shop/src/server.ts"
    );
    assert!(test_reach_violations(&reach, &scope, &root.opening()).is_empty());
    let repaired = File::new("src/server.ts", "export const isolated = 1", None);
    let reach = root_reach_of(
        &globs,
        &scope,
        &[root.opening(), repaired.opening(), test.opening()],
    );
    assert!(test_reach_violations(&reach, &scope, &test.opening()).is_empty());
    assert!(Arc::ptr_eq(
        &root_reach_of(&[], &scope, &[]),
        &root_reach_of(&[], &scope, &[])
    ));
}
