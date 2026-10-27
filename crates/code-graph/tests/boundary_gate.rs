use demlik_code_graph::{
    boundaries::{
        gate::{BoundaryFlags, BoundaryGateArgs, run_boundary_gate},
        ledger::{BoundaryLedger, LEDGER_FILENAME, LedgerRead, read_boundary_ledger},
        migrate::LEGACY_CEILINGS_FILENAME,
    },
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
                "demlik-boundary-gate-{}-{}",
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
    fn put(&self, file: &str, text: &str) {
        let file = self.0.join(file);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, text).unwrap();
    }
    fn project(&self) -> JsString {
        self.put("package.json", "{}");
        for (scope, feature) in [("services/api", "orders"), ("services/other", "billing")] {
            self.put(&format!("{scope}/package.json"), "{}");
            self.put(&format!("{scope}/tsconfig.json"), r#"{"compilerOptions":{"module":"esnext","moduleResolution":"bundler"},"include":["src/**/*.ts"]}"#);
            self.put(
                &format!("{scope}/src/{feature}/adapters/driven/store.ts"),
                "export const read = () => 1;",
            );
            self.put(&format!("{scope}/src/{feature}/application/run.ts"), "import {read} from '../adapters/driven/store'; export const run = () => {fetch('/'); return read();};");
        }
        self.put(
            "rules.json",
            r#"{"features":{"services/other":["billing"],"services/api":["orders"]}}"#,
        );
        self.0.join("rules.json").to_str().unwrap().into()
    }
    fn ledger(&self) -> BoundaryLedger {
        match read_boundary_ledger(
            &self.0.join(LEDGER_FILENAME),
            &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
        )
        .unwrap()
        {
            LedgerRead::Read { ledger } => ledger,
            result => panic!("expected the gate to write a valid ledger: {result:?}"),
        }
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
fn real_files_report_accept_gate_and_prune_only_the_measured_scope() {
    let repo = Repo::new();
    let rules = repo.project();
    let args = BoundaryGateArgs {
        root_absolute: &repo.0,
        repo_root: &repo.0,
        boundary_rules_file: Some(&rules),
        flags: BoundaryFlags::default(),
        json: true,
        pretty: false,
    };
    let report = run_boundary_gate(
        args,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(report.exit_code, 0);
    assert!(report.reports.is_empty());
    let snapshot: serde_json::Value =
        serde_json::from_str(&report.emitted[0].to_utf8().unwrap()).unwrap();
    assert_eq!(snapshot["scopes"][0]["scope"], "services/api");
    assert_eq!(snapshot["scopes"].as_array().unwrap().len(), 2);
    assert!(report.emitted[0].to_utf8().unwrap().ends_with('\n'));
    assert!(!repo.0.join(LEDGER_FILENAME).exists());
    let ci = BoundaryFlags {
        ci: true,
        ..Default::default()
    };
    assert_eq!(
        run_boundary_gate(
            BoundaryGateArgs { flags: ci, ..args },
            &demlik_code_graph::project::Collation::try_node22_en_us().unwrap()
        )
        .unwrap()
        .exit_code,
        1
    );
    let reason = JsString::from_units(vec![
        0xfeff, 32, 108, 101, 103, 97, 99, 121, 32, 0xd800, 0x2000,
    ]);
    let accept = BoundaryFlags {
        accept_crossings: true,
        reason: Some(&reason),
        ..Default::default()
    };
    assert_eq!(
        run_boundary_gate(
            BoundaryGateArgs {
                flags: accept,
                ..args
            },
            &demlik_code_graph::project::Collation::try_node22_en_us().unwrap()
        )
        .unwrap()
        .exit_code,
        0
    );
    assert_eq!(repo.ledger().entries.len(), 4);
    let expected_reason = JsString::from_units(vec![108, 101, 103, 97, 99, 121, 32, 0xd800]);
    assert!(
        repo.ledger()
            .entries
            .iter()
            .all(|entry| entry.reason.as_ref() == Some(&expected_reason))
    );
    let seeded = fs::read(repo.0.join(LEDGER_FILENAME)).unwrap();
    for _ in 0..2 {
        assert_eq!(
            run_boundary_gate(
                BoundaryGateArgs { flags: ci, ..args },
                &demlik_code_graph::project::Collation::try_node22_en_us().unwrap()
            )
            .unwrap()
            .exit_code,
            0
        );
        assert_eq!(fs::read(repo.0.join(LEDGER_FILENAME)).unwrap(), seeded);
    }
    repo.put(
        "services/api/src/orders/application/run.ts",
        "export const run = () => 1;",
    );
    let root = repo.0.join("services/api");
    let pruned = run_boundary_gate(
        BoundaryGateArgs {
            root_absolute: &root,
            flags: ci,
            ..args
        },
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(pruned.exit_code, 0);
    assert_eq!(repo.ledger().entries.len(), 2);
    assert!(
        repo.ledger()
            .entries
            .iter()
            .all(|entry| entry.scope == "services/other")
    );
    let JsValue::Object(snapshot) = JsValue::parse(&pruned.emitted[0].to_utf8().unwrap()).unwrap()
    else {
        panic!("pruning emits an object");
    };
    let JsValue::Array(pruned) = &snapshot[&JsString::from("pruned")] else {
        panic!("pruned entries form an array");
    };
    assert_eq!(pruned.len(), 2);
}

#[test]
fn migration_checks_every_declared_scope_before_replacing_the_legacy_file() {
    let repo = Repo::new();
    let rules = repo.project();
    let root = repo.0.join("services/api");
    let args = BoundaryGateArgs {
        root_absolute: &root,
        repo_root: &repo.0,
        boundary_rules_file: Some(&rules),
        flags: BoundaryFlags {
            migrate_ceilings: true,
            ..Default::default()
        },
        json: true,
        pretty: true,
    };
    let legacy = r#"{"default":0,"scopes":{"services/api":10}}"#;
    repo.put(LEGACY_CEILINGS_FILENAME, legacy);
    let refused = run_boundary_gate(
        args,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(refused.exit_code, 2);
    assert!(refused.emitted.is_empty());
    assert!(
        refused.reports[0]
            .to_utf8()
            .unwrap()
            .contains("services/other")
    );
    assert_eq!(
        fs::read_to_string(repo.0.join(LEGACY_CEILINGS_FILENAME)).unwrap(),
        legacy
    );
    assert!(!repo.0.join(LEDGER_FILENAME).exists());
    repo.put(LEGACY_CEILINGS_FILENAME, r#"{"default":1}"#);
    let migrated = run_boundary_gate(
        args,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(migrated.exit_code, 0);
    assert_eq!(repo.ledger().entries.len(), 4);
    assert!(!repo.0.join(LEGACY_CEILINGS_FILENAME).exists());
    assert!(
        migrated.emitted[0]
            .to_utf8()
            .unwrap()
            .contains("\"scopes\": 2")
    );
    let repeated = run_boundary_gate(
        args,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(repeated.exit_code, 2);
    assert_eq!(
        repeated.reports,
        [JsString::from(
            "boundary-ledger.json already exists; there is nothing to migrate."
        )]
    );
}

#[test]
fn flag_refusals_precede_any_config_or_project_read() {
    let repo = Repo::new();
    let missing: JsString = repo.0.join("missing.json").to_str().unwrap().into();
    let args = BoundaryGateArgs {
        root_absolute: &repo.0,
        repo_root: &repo.0,
        boundary_rules_file: Some(&missing),
        flags: BoundaryFlags {
            write_ceilings: true,
            ci: true,
            accept_crossings: true,
            ..Default::default()
        },
        json: false,
        pretty: false,
    };
    let result = run_boundary_gate(
        args,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert_eq!(result.exit_code, 2);
    assert!(result.emitted.is_empty());
    assert_eq!(result.reports.len(), 1);
    assert!(result.reports[0].starts_with("`--boundaries --write-ceilings` is retired"));
    assert_eq!(fs::read_dir(&repo.0).unwrap().count(), 0);
}
