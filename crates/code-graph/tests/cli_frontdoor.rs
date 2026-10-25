use demlik_code_graph::{
    cli::{
        frontdoor::{Preparation, prepare_cli},
        io::CliIo,
    },
    text::JsString,
};
use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
};
static ORDINAL: AtomicU64 = AtomicU64::new(0);
struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        loop {
            let root = std::env::temp_dir().join(format!(
                "demlik-frontdoor-consumer-{}-{}",
                std::process::id(),
                ORDINAL.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&root) {
                Ok(()) => return Self(root),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("{error}"),
            }
        }
    }
    fn text(&self) -> JsString {
        self.0.to_string_lossy().as_ref().into()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0)
            && !std::thread::panicking()
        {
            panic!("fixture cleanup: {error}")
        }
    }
}

#[test]
fn parser_stops_before_path_and_configuration_io_and_returns_explicit_termination() {
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut stdout, &mut stderr, Some(7));
    let argv = [JsString::from("--help")];
    let Preparation::Stopped(stop) = prepare_cli(&argv, None, &mut host).unwrap() else {
        panic!("help prepared a graph")
    };
    assert_eq!(stop.exit_code(&host), 0);
    assert_eq!(host.exit_state().stored_code(), Some(0));
}

#[test]
fn non_api_run_returns_all_options_and_prepared_configs_without_discovering_a_compiler() {
    use demlik_code_graph::{cli::frontdoor::ApiDispatch, engine::tsgo::TsgoBinary};
    let fixture = Fixture::new();
    let config = fixture.0.join("thresholds.json");
    fs::write(&config, r#"{"longFunctionLoc":21}"#).unwrap();
    let argv = [
        fixture.text(),
        "--graph".into(),
        "--data".into(),
        "--thresholds".into(),
        config.to_string_lossy().as_ref().into(),
        "--entry-preset=nextjs".into(),
    ];
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut stdout, &mut stderr, None);
    let Preparation::Prepared(prepared) = prepare_cli(&argv, None, &mut host).unwrap() else {
        panic!("valid project refused")
    };
    let ApiDispatch::Continue(prepared) = prepared
        .dispatch_api_blocking(&TsgoBinary::pinned("/missing/unused/compiler"), &mut host)
        .unwrap()
    else {
        panic!("non-API graph was claimed executed")
    };
    assert_eq!(prepared.options.graph(), Some(true));
    assert_eq!(prepared.options.data(), Some(true));
    assert_eq!(prepared.thresholds.long_function_loc, 21);
    assert_eq!(prepared.kind_rules.entry_export_presets.len(), 1);
    drop(host);
    assert!(stdout.is_empty());
    assert!(stderr.is_empty());
}

#[test]
fn threshold_refusal_precedes_api_strays_and_map_reads() {
    use demlik_code_graph::cli::frontdoor::{CliStop, ConfigStage, PreflightRefusal};
    let fixture = Fixture::new();
    let bad = fixture.0.join("bad.json");
    fs::write(&bad, "{").unwrap();
    let argv = [
        fixture.text(),
        "--api=missing-map.json".into(),
        "--by=rot".into(),
        "--thresholds".into(),
        bad.to_string_lossy().as_ref().into(),
    ];
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut host = CliIo::new(&mut stdout, &mut stderr, None);
    let Preparation::Stopped(CliStop::Refused(PreflightRefusal::Config {
        stage: ConfigStage::Thresholds,
        ..
    })) = prepare_cli(&argv, None, &mut host).unwrap()
    else {
        panic!("wrong refusal precedence")
    };
    assert_eq!(host.exit_state().stored_code(), Some(2));
    drop(host);
    assert!(stdout.is_empty());
    assert!(
        String::from_utf8(stderr)
            .unwrap()
            .contains("is not valid JSON")
    );
}
