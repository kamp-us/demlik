use demlik_code_graph::{
    hexagon::{read_hexagon, render_hexagon},
    text::JsString,
};
use std::{fs, path::Path};

#[test]
fn feature_inventories_match_the_frozen_text_and_json_reports() {
    for fixture in ["full", "unbagged", "not-read"] {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/code-graph/test/hexagon")
            .join(fixture);
        let report = read_hexagon(&JsString::from(root.to_string_lossy().as_ref())).unwrap();
        if fixture == "full" {
            assert_eq!(report.feature.as_ref().unwrap(), "Warehouse");
            assert_eq!(report.commands.len(), 3);
        }
        let expected = fs::read_to_string(root.join("expected.txt")).unwrap();
        let actual = render_hexagon(&report, false, false).unwrap();
        assert_eq!(actual.to_lossy(), expected.trim_end_matches('\n'));
        let expected = fs::read_to_string(root.join("expected.json")).unwrap();
        let actual = render_hexagon(&report, true, false).unwrap();
        assert_eq!(actual.to_lossy(), expected.trim_end_matches('\n'));
    }
}

#[test]
fn an_escaping_report_error_retains_the_layout_failure_that_triggered_it() {
    use demlik_code_graph::{
        api::map::{ApiCallbackError, ApiError},
        hexagon::{HexagonOutput, run_hexagon},
    };
    let root = std::env::temp_dir().join(format!("demlik-hexagon-report-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let mut emitted = Vec::new();
    let mut reported = Vec::new();
    let mut emit = |payload: &JsString| {
        emitted.push(payload.clone());
        Ok(())
    };
    let mut report = |message: &JsString| {
        reported.push(message.clone());
        Err(ApiError::Callback(ApiCallbackError::new(
            "report failed".into(),
        )))
    };
    let result = run_hexagon(
        &root.to_string_lossy().as_ref().into(),
        HexagonOutput {
            json: false,
            pretty: false,
            emit: &mut emit,
            report: &mut report,
        },
    );
    fs::remove_dir_all(&root).unwrap();
    let error = result.unwrap_err();
    assert_eq!(error.message(), JsString::from("report failed"));
    assert_eq!(reported, [error.processing.message()]);
    assert!(error.processing.message().starts_with("missing ports.ts: "));
    assert!(emitted.is_empty());
}

#[test]
fn the_cli_hexagon_runs_before_other_modes_without_a_tsconfig_or_compiler() {
    use demlik_code_graph::{
        cli::{
            frontdoor::{ApiDispatch, HexagonDispatch, Preparation, prepare_cli},
            io::CliIo,
        },
        engine::tsgo::TsgoBinary,
    };
    let root =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/code-graph/test/hexagon/full");
    let argv = [
        JsString::from(root.to_string_lossy().as_ref()),
        "--hexagon".into(),
        "--accept-dead".into(),
        "--accept-smells".into(),
        "--layers".into(),
        "--deep".into(),
        "--edges".into(),
        "--by=complexity".into(),
    ];
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut stdout, &mut stderr, Some(7));
    let Preparation::Prepared(prepared) = prepare_cli(&argv, None, &mut host).unwrap() else {
        panic!("valid feature refused")
    };
    let ApiDispatch::Continue(prepared) = prepared
        .dispatch_api_blocking(&TsgoBinary::pinned("/missing/unused/compiler"), &mut host)
        .unwrap()
    else {
        panic!("API unexpectedly active")
    };
    let HexagonDispatch::Complete(outcome) = prepared.dispatch_hexagon(&mut host).unwrap() else {
        panic!("hexagon left unexecuted")
    };
    assert!(outcome.failure.is_none());
    assert_eq!(host.normal_exit_code(), 7);
    drop(host);
    assert_eq!(stdout, fs::read(root.join("expected.txt")).unwrap());
    assert!(stderr.is_empty());
}
