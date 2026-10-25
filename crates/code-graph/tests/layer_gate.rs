use demlik_code_graph::{
    layers::gate::{LayerGateArgs, run_layer_gate},
    text::JsString,
};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Project(PathBuf);
impl Project {
    fn new() -> Self {
        let root = loop {
            let root = std::env::temp_dir().join(format!(
                "demlik-layer-gate-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&root) {
                Ok(()) => break root,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create fixture: {error}"),
            }
        };
        Self(root)
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
fn a_real_gate_reports_upward_sites_then_passes_the_exact_allowance_and_refuses_bad_config() {
    let project = Project::new();
    fs::create_dir_all(project.0.join("src/domain")).unwrap();
    fs::write(
        project.0.join("src/service.ts"),
        "export type Service=unknown;",
    )
    .unwrap();
    fs::write(
        project.0.join("src/domain/rule.ts"),
        "// first\nimport type { Service } from '../service.js';\nexport const x=1;",
    )
    .unwrap();
    let file = project.0.join("rules.json");
    let file_text: JsString = file.to_string_lossy().as_ref().into();
    let stack =
        r#""layers":[{"name":"service","paths":["src"]},{"name":"domain","paths":["src/domain"]}]"#;
    fs::write(&file, format!("{{{stack}}}")).unwrap();
    let args = LayerGateArgs {
        root_absolute: &project.0,
        repo_root: &project.0,
        layer_rules_file: Some(&file_text),
        json: false,
        pretty: false,
    };
    let fail = run_layer_gate(args).unwrap();
    assert_eq!(fail.exit_code, 1);
    assert!(fail.reports.is_empty());
    assert_eq!(fail.emitted.len(), 1);
    assert!(
        fail.emitted[0]
            .to_utf8()
            .unwrap()
            .contains("src/domain/rule.ts:2  domain -> service")
    );
    assert!(fail.emitted[0].to_utf8().unwrap().ends_with('\n'));
    fs::write(&file,format!(r#"{{{stack},"allowed":[{{"from":"src/domain/rule.ts","to":"src/service.ts","sites":1,"reason":"pass it in"}}]}}"#)).unwrap();
    let pass = run_layer_gate(LayerGateArgs {
        json: true,
        pretty: true,
        ..args
    })
    .unwrap();
    assert_eq!(pass.exit_code, 0);
    assert!(
        pass.emitted[0]
            .to_utf8()
            .unwrap()
            .contains("\"passed\": true")
    );
    assert!(
        pass.emitted[0]
            .to_utf8()
            .unwrap()
            .contains("\"typeOnly\": true")
    );
    fs::write(&file, "{").unwrap();
    let refused = run_layer_gate(args).unwrap();
    assert_eq!(refused.exit_code, 2);
    assert!(refused.emitted.is_empty());
    assert_eq!(
        refused.reports[0],
        format!("config file \"{}\" is not valid JSON.", file.display())
    );
    let missing_stack = run_layer_gate(LayerGateArgs {
        layer_rules_file: None,
        ..args
    })
    .unwrap();
    assert_eq!(missing_stack.exit_code, 2);
    assert_eq!(
        missing_stack.reports[0],
        "no layer stack declared; pass --layer-rules <file> with a `layers` array."
    );
}
