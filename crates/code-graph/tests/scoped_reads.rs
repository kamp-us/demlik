use demlik_code_graph::{
    boundaries::{
        libraries::{LibrariesRead, read_libraries},
        rules::BoundaryRules,
        shape::{ShapeRead, read_shape, shape_facts_of},
        zones::reads::{
            DrivenVerdict, ReadImports, ReadModule, driven_reads_of, first_write,
            read_allowance_of, scope_reads_of, unknown_driven,
        },
    },
    engine::oxc::parse_type_script,
    extract::wrangler_config::load_binding_catalog,
    syntax::imports::{ImportEdge, import_literals, runtime_specifiers},
    text::{JsString, JsValue},
};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Repo(PathBuf);
impl Repo {
    fn new() -> Self {
        loop {
            let root = std::env::temp_dir().join(format!(
                "demlik-scoped-reads-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&root) {
                Ok(()) => return Self(root),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create fixture: {error}"),
            }
        }
    }
    fn write(&self, file: &str, content: &str) {
        let file = self.0.join(file);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, content).unwrap();
    }
}

#[test]
fn handlers_borrow_one_write_fact_and_need_a_runtime_decision_for_listed_reads() {
    let repo = Repo::new();
    repo.write("packages/kernel/package.json", r#"{"name":"@shop/kernel"}"#);
    let rules = BoundaryRules::parse(&JsValue::parse(r#"{
      "libraryTypes":{"kernel":{"imports":[],"pure":true}},
      "libraries":{"packages/kernel":"kernel"},
      "readAllowance":{"services/api":{"driven":["read.ts","write.ts","gone.ts"],"decidedBy":["kernel"]}}
    }"#).unwrap()).unwrap();
    let catalog = load_binding_catalog(&repo.0, None).unwrap();
    let allowance = read_allowance_of(&rules.read_allowance, &catalog);
    let scope = "services/api".into();
    let read: JsString = "read.ts".into();
    let write: JsString = "write.ts".into();
    let site = demlik_code_graph::boundaries::deployables::BindingSite {
        binding: "DB".into(),
        line: 7.0,
    };
    let loaded = [read.clone(), write.clone()].into_iter().collect();
    assert_eq!(
        unknown_driven(&allowance, &scope, &loaded),
        [&JsString::from("gone.ts")]
    );
    let reads = scope_reads_of(
        &allowance,
        &scope,
        &[
            ReadModule {
                file: &read,
                first_write: None,
            },
            ReadModule {
                file: &write,
                first_write: Some(&site),
            },
        ],
    )
    .unwrap();
    let LibrariesRead::Read(libraries) = read_libraries(&rules, &repo.0, None).unwrap() else {
        panic!("fixture libraries refused")
    };
    for (source, licensed) in [
        ("import { decide } from '@shop/kernel';", true),
        ("import type { Decision } from '@shop/kernel';", false),
        ("import { type Decision } from '@shop/kernel';", false),
        ("", false),
    ] {
        let syntax = parse_type_script(&repo.0.join("http.ts"), source).unwrap();
        let edges: Vec<_> = import_literals(&syntax)
            .into_iter()
            .map(|edge| ImportEdge {
                specifier: edge.specifier,
                kind: edge.kind,
                type_only: edge.type_only,
                target: None,
            })
            .collect();
        let runtime = runtime_specifiers(&syntax);
        let verdicts = driven_reads_of(
            Some(&reads),
            ReadImports {
                import_edges: &edges,
                runtime_specifiers: &runtime,
            },
            &libraries,
        );
        assert_eq!(
            matches!(verdicts.verdict(&read), DrivenVerdict::Licensed),
            licensed
        );
        assert!(matches!(
            verdicts.verdict(&"other.ts".into()),
            DrivenVerdict::Unlicensed
        ));
        let DrivenVerdict::Write(first) = verdicts.verdict(&write) else {
            panic!("write must prevent licensing")
        };
        let DrivenVerdict::Write(again) = verdicts.verdict(&write) else {
            panic!("write fact lost")
        };
        assert!(std::ptr::eq(first, again));
        assert!(std::ptr::eq(first, &reads.writes[&write]));
        assert_eq!(first.file, "services/api/write.ts");
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
fn listed_files_keep_the_first_visible_write_of_their_nearest_worker() {
    let repo = Repo::new();
    repo.write(
        "services/api/wrangler.jsonc",
        r#"{"name":"api","d1_databases":[{"binding":"DB"}],"kv_namespaces":[{"binding":"CACHE"}]}"#,
    );
    repo.write(
        "services/api/nested/wrangler.toml",
        "name = 'nested'\n[[kv_namespaces]]\nbinding = 'ONLY'\n",
    );
    let source = "export function read(env: Env) {\n  env.DB.prepare('SELECT 1');\n  env.CACHE.put('a','b'); env.DB.exec('DELETE FROM t');\n}";
    let file: JsString = "src/orders/adapters/driven/read.ts".into();
    let nested: JsString = "nested/read.ts".into();
    repo.write(&format!("services/api/{}", file.to_utf8().unwrap()), source);
    repo.write("services/api/nested/read.ts", source);
    let catalog = load_binding_catalog(&repo.0, None).unwrap();
    assert_eq!(catalog.manifests.len(), 2);
    let rules = BoundaryRules::parse(&JsValue::parse(r#"{"readAllowance":{"services/api":{"driven":["src/orders/adapters/driven/read.ts","nested/read.ts"]}}}"#).unwrap()).unwrap();
    let allowance = read_allowance_of(&rules.read_allowance, &catalog);
    let syntax = parse_type_script(
        &repo.0.join("services/api").join(file.to_utf8().unwrap()),
        source,
    )
    .unwrap();
    let first = first_write(&allowance, &"services/api".into(), &file, &syntax);
    assert_eq!(
        first.as_ref().map(|site| (&site.binding, site.line)),
        Some((&JsString::from("CACHE"), 3.0))
    );
    assert!(first_write(&allowance, &"services/api".into(), &nested, &syntax).is_none());
    assert!(first_write(&allowance, &"services/other".into(), &file, &syntax).is_none());
}

#[test]
fn shape_preparation_refuses_unread_configs_only_for_declared_reads_and_gates_entry_facts() {
    use demlik_code_graph::extract::wrangler_config::BindingCatalog;
    let catalog = BindingCatalog {
        manifests: vec![],
        unparsed_configs: vec!["services/api/wrangler.jsonc".into()],
    };
    let mut rules = BoundaryRules::parse(
        &JsValue::parse(
            r#"{
      "applicationShape":["index-not-exports-only"],
      "pureDependencies":["@shop/{kernel,contracts}"],
      "testFiles":["**/*.test.ts"],
      "compositionRoots":["services/api/src/main.ts"]
    }"#,
        )
        .unwrap(),
    )
    .unwrap();
    let ShapeRead::Read(shape) = read_shape(&rules, &catalog).unwrap() else {
        panic!("disabled allowance refused")
    };
    assert!(std::ptr::eq(shape.allowance.catalog, &catalog));
    let syntax = parse_type_script(
        std::path::Path::new("index.ts"),
        "export { a } from './a'; export const later=1;",
    )
    .unwrap();
    let facts = shape_facts_of(
        &shape,
        &"services/api".into(),
        &"src/orders/index.ts/".into(),
        &syntax,
    );
    assert_eq!(facts.offending_form, Some(JsString::from("declaration")));
    assert!(facts.first_write.is_none());
    assert!(
        shape_facts_of(&shape, &".".into(), &"other.ts".into(), &syntax)
            .offending_form
            .is_none()
    );
    rules.read_allowance.insert(
        "services/api".into(),
        demlik_code_graph::boundaries::rules::ReadAllowance {
            driven: vec!["read.ts".into()],
            decided_by: None,
        },
    );
    rules.pure_dependencies = vec!["{".into()];
    let ShapeRead::Refused { message } = read_shape(&rules, &catalog).unwrap() else {
        panic!("unread config granted reads")
    };
    assert!(
        message
            .to_utf8()
            .unwrap()
            .starts_with("a wrangler config cannot be parsed: services/api/wrangler.jsonc.")
    );
    rules.read_allowance.clear();
    assert!(read_shape(&rules, &catalog).is_err());
}
