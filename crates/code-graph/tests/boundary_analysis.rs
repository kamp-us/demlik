use demlik_code_graph::{
    boundaries::{
        analyze::{BoundaryModule, ScopeInputs, analyze_boundaries},
        deployables::{DeployablesRead, bindings::binding_sites_of, read_deployables},
        impure_uses::detect_impure_uses,
        libraries::{LibrariesRead, allowance::imported_names_for, read_libraries},
        rules::{BoundaryRules, in_scope},
        shape::{ShapeRead, read_shape, shape_facts_of},
        violation::BoundaryViolation,
    },
    extract::wrangler_config::load_binding_catalog,
    project::{EdgeScope, load_edge_project},
    syntax::imports::{resolve_imports, runtime_specifiers},
    text::{JsString, JsValue},
};
use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Repo(PathBuf);
impl Repo {
    fn new() -> Self {
        loop {
            let path = std::env::temp_dir().join(format!(
                "demlik-boundary-analysis-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed),
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create fixture: {error}"),
            }
        }
    }
    fn write(&self, file: &str, text: &str) {
        let path = self.0.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
}
impl Drop for Repo {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0)
            && !std::thread::panicking()
        {
            panic!("remove fixture: {error}");
        }
    }
}

#[test]
fn a_loaded_worker_combines_rules_and_shares_its_write_fact_across_crossings() {
    let repo = Repo::new();
    repo.write("package.json", "{}");
    repo.write("services/api/package.json", "{}");
    repo.write("services/api/tsconfig.json", r#"{"compilerOptions":{"moduleResolution":"bundler","module":"esnext"},"include":["src/**/*.ts"]}"#);
    repo.write(
        "services/api/wrangler.jsonc",
        r#"{"name":"api","main":"src/main.ts","d1_databases":[{"binding":"DB"}]}"#,
    );
    for (file, source) in [
        ("src/main.ts", "export const app = 1;"),
        ("src/harness.ts", "export { app } from './main';"),
        ("src/orders/index.ts", "export const order = 1;"),
        ("src/orders/ports.ts", "export type Port = {run(): void};"),
        (
            "src/orders/application/run.ts",
            "import { write } from '../adapters/driven/store'; write(); fetch('/orders'); import('third-party');",
        ),
        (
            "src/orders/adapters/driven/store.ts",
            "export function write() { env.DB.exec('DELETE FROM orders'); }",
        ),
        (
            "src/orders/adapters/driving/http.ts",
            "import { write } from '../driven/store'; import { write as again } from '../driven/store.js'; export const handle = () => { write(); again(); };",
        ),
        ("src/orders/mystery/one.ts", "export const one = 1;"),
        ("src/orders/mystery/two.ts", "export const two = 2;"),
        (
            "src/orders/mystery/wiring.test.ts",
            "import '../../harness'; export const test = 1;",
        ),
    ] {
        repo.write(&format!("services/api/{file}"), source);
    }
    let rules = BoundaryRules::parse(
        &JsValue::parse(
            r#"{
        "features":{"services/api":["orders"]},
        "acrossDeployables":["binding-outside-driven-adapter"],
        "applicationShape":["index-not-exports-only","application-import-outside-allowlist"],
        "testFiles":["**/*.test.ts"],
        "compositionRoots":["src/main.ts"],
        "readAllowance":{"services/api":{"driven":["src/orders/adapters/driven/store.ts"]}}
    }"#,
        )
        .unwrap(),
    )
    .unwrap();
    let catalog = load_binding_catalog(
        &repo.0,
        None,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    let LibrariesRead::Read(libraries) = read_libraries(
        &rules,
        &repo.0,
        None,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap() else {
        panic!("fixture libraries refused");
    };
    let DeployablesRead::Read(deployables) = read_deployables(&rules, &repo.0, None, &catalog)
    else {
        panic!("fixture deployables refused");
    };
    let ShapeRead::Read(shape) = read_shape(&rules, &catalog).unwrap() else {
        panic!("fixture shape refused");
    };
    let scope: JsString = "services/api".into();
    let loaded = load_edge_project(
        &repo.0.join("services/api"),
        EdgeScope::Package,
        &repo.0,
        None,
    )
    .unwrap();
    assert!(loaded.project.parse_failures.is_empty());
    let graph = resolve_imports(
        &loaded.project.root_absolute,
        &loaded.project.source_files,
        &loaded.ts_config_path,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    let facts: Vec<_> = loaded
        .project
        .source_files
        .iter()
        .map(|unit| {
            let file: JsString = unit.file.as_str().into();
            let shape = shape_facts_of(&shape, &scope, &file, &unit.syntax);
            let imported = imported_names_for(&libraries, &scope, &unit.syntax);
            let uses = detect_impure_uses(&unit.syntax);
            let runtime = runtime_specifiers(&unit.syntax);
            let sites = binding_sites_of(&deployables, &in_scope(&scope, &file), &unit.syntax);
            (file, shape, imported, uses, runtime, sites)
        })
        .collect();
    let modules: Vec<_> = loaded
        .project
        .source_files
        .iter()
        .zip(&facts)
        .map(|(unit, facts)| BoundaryModule {
            file: &facts.0,
            import_edges: &graph.import_edges_by_file[&unit.file],
            shape: &facts.1,
            imported_names: &facts.2,
            impure_uses: &facts.3,
            runtime_specifiers: &facts.4,
            binding_sites: &facts.5,
        })
        .collect();
    let result = analyze_boundaries(
        &scope,
        &modules,
        &rules,
        ScopeInputs {
            libraries: &libraries,
            deployables: &deployables,
            shape: &shape,
        },
    )
    .unwrap();
    assert_eq!(result.report.files_scanned, 10.0);
    assert_eq!(result.report.features, [JsString::from("orders")]);
    let writes: Vec<_> = result
        .report
        .violations
        .iter()
        .filter_map(|violation| match violation {
            BoundaryViolation::DrivingReachesDriven {
                write: Some(write), ..
            } => Some(write),
            _ => None,
        })
        .collect();
    assert_eq!(
        writes.len(),
        2,
        "both spellings reach the same writing adapter"
    );
    assert!(Arc::ptr_eq(writes[0], writes[1]));
    assert_eq!(writes[0].binding, "DB");
    assert_eq!(
        writes[0].file,
        "services/api/src/orders/adapters/driven/store.ts"
    );
    assert!(
        result
            .report
            .violations
            .iter()
            .any(|violation| matches!(violation,
        BoundaryViolation::ApplicationImportsAdapter { from, .. }
            if from == "services/api/src/orders/application/run.ts"))
    );
    assert!(
        result
            .report
            .violations
            .iter()
            .any(|violation| matches!(violation,
        BoundaryViolation::IndexNotExportsOnly { from, .. }
            if from == "services/api/src/orders/index.ts"))
    );
    assert!(
        result
            .report
            .violations
            .iter()
            .any(|violation| matches!(violation,
        BoundaryViolation::TestReachesCompositionRoot { to, .. }
            if to == "services/api/src/harness.ts"))
    );
    assert_eq!(
        result
            .report
            .violations
            .iter()
            .filter(|violation| matches!(violation, BoundaryViolation::UnknownZone { .. }))
            .count(),
        1
    );
    assert_eq!(result.sites.len(), 1);
    assert_eq!(result.sites[0].binding, "DB");
}
