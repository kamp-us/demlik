use demlik_code_graph::{
    layers::{
        analyze::analyze_layers,
        rules::{Layer, LayerRules},
    },
    project::load_cheap_project,
    text::JsValue,
};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Project(PathBuf);
impl Project {
    fn new(files: &[(&str, &str)]) -> Self {
        let root = loop {
            let root = std::env::temp_dir().join(format!(
                "demlik-layers-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&root) {
                Ok(()) => break root,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create fixture: {error}"),
            }
        };
        let out = Self(root);
        for (file, contents) in files {
            let file = out.0.join(file);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, contents).unwrap();
        }
        out
    }
}

#[test]
fn allowlist_matches_exact_sites_and_keeps_the_last_duplicate_declaration_as_owner() {
    use demlik_code_graph::layers::{
        analyze::{LayerCensus, LayerEdge, LayerReport},
        reconcile::{edge_key, reconcile},
        rules::AllowedEdge,
    };
    let edge = |from: &str, to: &str, line| LayerEdge {
        from: from.into(),
        from_line: line,
        from_layer: "domain".into(),
        to: to.into(),
        to_line: 1,
        to_layer: "service".into(),
        specifier: "../target".into(),
        type_only: false,
    };
    let allow = |from: &str, to: &str, sites| AllowedEdge {
        from: from.into(),
        to: to.into(),
        sites,
        reason: "pass it in".into(),
    };
    let report = LayerReport {
        layers: vec!["service".into(), "domain".into()],
        files_scanned: 3,
        census: LayerCensus {
            up: 3,
            ..Default::default()
        },
        violations: vec![
            edge("a", "target", 3),
            edge("a", "target", 9),
            edge("b", "other", 4),
        ],
        unresolved: Vec::new(),
    };
    let wrong = vec![allow("a", "target", 1), allow("closed", "target", 1)];
    let failed = reconcile(
        &report,
        &wrong,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert!(!failed.passed);
    assert_eq!(failed.allowed_sites, 0);
    assert_eq!(failed.undeclared.len(), 1);
    assert_eq!(failed.stale.len(), 1);
    assert_eq!(failed.miscounted[0].actual, 2);
    let exact = vec![
        allow("a", "target", 1),
        allow("a", "target", 2),
        allow("b", "other", 1),
    ];
    let pass = reconcile(
        &report,
        &exact,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert!(pass.passed);
    assert_eq!(pass.allowed_sites, 3);
    assert_eq!(
        edge_key(&"a b".into(), &"c".into()),
        edge_key(&"a".into(), &"b c".into())
    );
}

#[test]
fn external_rules_keep_default_empty_stack_but_refuse_explicit_short_or_invalid_declarations() {
    assert!(
        LayerRules::parse(&JsValue::parse("{}").unwrap())
            .unwrap()
            .layers
            .is_empty()
    );
    for (raw, path, message) in [
        (
            r#"{"layers":[]}"#,
            r#"["layers"]"#,
            "Too small: expected array to have >=2 items",
        ),
        (
            r#"{"layers":[{}]}"#,
            r#"["layers",0,"name"]"#,
            "Invalid input: expected string, received undefined",
        ),
        (
            r#"{"layers":[{"name":"a","paths":[]},{"name":"b","paths":["b"]}]}"#,
            r#"["layers",0,"paths"]"#,
            "Too small: expected array to have >=1 items",
        ),
        (
            r#"{"allowed":[{"from":"a","to":"b","sites":1.5,"reason":"why"}]}"#,
            r#"["allowed",0,"sites"]"#,
            "Invalid input: expected int, received number",
        ),
        (
            r#"{"allowed":[{"from":"a","to":"b","sites":0,"reason":"why"}]}"#,
            r#"["allowed",0,"sites"]"#,
            "Too small: expected number to be >0",
        ),
        (
            r#"{"allowed":[{"from":"a","to":"b","sites":9007199254740992,"reason":"why"}]}"#,
            r#"["allowed",0,"sites"]"#,
            "Too big: expected int to be <9007199254740991",
        ),
    ] {
        let issue = LayerRules::parse(&JsValue::parse(raw).unwrap()).unwrap_err();
        assert_eq!(serde_json::to_string(issue.path()).unwrap(), path);
        assert_eq!(issue.message(), message);
    }
}
impl Drop for Project {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0)
            && !std::thread::panicking()
        {
            panic!("remove fixture: {error}");
        }
    }
}

#[test]
fn real_aliased_imports_keep_their_lines_type_only_status_and_missing_local_sites() {
    let project = Project::new(&[
        (
            "apps/web/tsconfig.json",
            r#"{"compilerOptions":{"paths":{"@app/*":["./src/*"]}}}"#,
        ),
        (
            "apps/web/src/ui/page.tsx",
            "import { invoice } from '@app/features/billing/invoice';\nimport { total } from '@app/features/billing/total.js';\nexport const page=invoice+total;",
        ),
        (
            "apps/web/src/features/billing/invoice.ts",
            "import { money } from '@app/lib/money';\nimport type { Page } from '@app/ui/page';\nimport { gone } from '@app/features/billing/gone';\nexport const invoice=money+gone;",
        ),
        (
            "apps/web/src/features/billing/total.ts",
            "// line1\nimport { page } from '@app/ui/page';\nimport { money } from '../../lib/money';\nexport const total=page+money;",
        ),
        (
            "apps/web/src/lib/money.ts",
            "import fs from 'node:fs';\nimport pad from 'left-pad';\nimport missing from 'not-installed';\nimport { env } from 'cloudflare:workers';\nexport const money=fs+pad+missing+env;",
        ),
        (
            "node_modules/left-pad/package.json",
            r#"{"name":"left-pad","main":"index.js"}"#,
        ),
        ("node_modules/left-pad/index.js", "module.exports=1;"),
    ]);
    let rules = LayerRules {
        layers: [
            ("ui", "apps/web/src/ui"),
            ("features", "apps/web/src/features"),
            ("lib", "apps/web/src/lib"),
        ]
        .into_iter()
        .map(|(name, path)| Layer {
            name: name.into(),
            paths: vec![path.into()],
        })
        .collect(),
        allowed: Vec::new(),
    };
    let loaded = load_cheap_project(&project.0, None).unwrap();
    let report = analyze_layers(
        &loaded,
        &project.0,
        &rules,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(report.files_scanned, 4);
    assert_eq!(
        (
            report.census.down,
            report.census.up,
            report.census.external,
            report.census.unresolved
        ),
        (4, 2, 4, 1)
    );
    assert_eq!(report.violations.len(), 2);
    assert_eq!(
        report.violations[0].from,
        "apps/web/src/features/billing/invoice.ts"
    );
    assert_eq!(report.violations[0].from_line, 2);
    assert_eq!(report.violations[0].to, "apps/web/src/ui/page.tsx");
    assert!(report.violations[0].type_only);
    assert!(!report.violations[1].type_only);
    assert_eq!(
        report.unresolved[0],
        "apps/web/src/features/billing/invoice.ts:3 @app/features/billing/gone"
    );
}
