use demlik_code_graph::{
    api::{
        cli::{ApiExit, ApiFlags, ApiHost, run_api_flags_blocking},
        map::ApiError,
    },
    engine::tsgo::TsgoBinary,
    text::JsString,
};
use std::{cell::RefCell, rc::Rc};

#[test]
fn inactive_and_refused_modes_preserve_given_attribute_order_without_reading_files() {
    let root = JsString::from("no-such-root");
    let map = JsString::from("no-such-map.json");
    let policy = JsString::from("no-such-policy.json");
    let compiler = TsgoBinary::pinned("no-such-compiler");
    let trace = Rc::new(RefCell::new(Vec::<JsString>::new()));
    let emitted = Rc::clone(&trace);
    let reported = Rc::clone(&trace);
    let mut emit = move |line: &JsString| -> Result<(), ApiError> {
        emitted.borrow_mut().push(line.clone());
        Ok(())
    };
    let mut report = move |line: &JsString| -> Result<(), ApiError> {
        reported.borrow_mut().push(line.clone());
        Ok(())
    };
    let given = vec![
        JsString::from("api"),
        "layerScope".into(),
        "URL".into(),
        "layerScope".into(),
    ];
    let inactive = run_api_flags_blocking(
        ApiFlags::default(),
        ApiHost {
            root_absolute: &root,
            given: &given,
            json: false,
            pretty: false,
            emit: &mut emit,
            report: &mut report,
        },
        &compiler,
    )
    .unwrap();
    assert!(inactive.is_none());
    assert!(trace.borrow().is_empty());
    let code = run_api_flags_blocking(
        ApiFlags {
            api: Some(&map),
            api_base: None,
            api_policy: Some(&policy),
        },
        ApiHost {
            root_absolute: &root,
            given: &given,
            json: false,
            pretty: false,
            emit: &mut emit,
            report: &mut report,
        },
        &compiler,
    )
    .unwrap();
    assert_eq!(code.unwrap().exit, ApiExit::Refused);
    assert_eq!(
        trace.borrow().as_slice(),
        [JsString::from(
            "--api takes only --api-base, --api-policy, --json, --pretty and --out; got --layer-scope, ---u-r-l, --layer-scope"
        )]
    );
}
#[path = "support/api_repo.rs"]
mod support;

#[test]
fn actual_view_payload_emits_once_and_raw_callback_failure_stays_observable() {
    use demlik_code_graph::api::{
        cli::{ApiRun, run_api_view_blocking},
        map::ApiCallbackError,
    };
    use std::{error::Error, sync::Arc};
    #[derive(Debug)]
    struct Cause(Arc<()>);
    impl std::fmt::Display for Cause {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("original callback cause")
        }
    }
    impl Error for Cause {}
    let repo = support::Repo::new();
    repo.put("packages/demo/src/index.ts", "export const value = 1;\n");
    repo.put(
        "packages/demo/api-map.json",
        r#"{".":{"entry":"src/index.ts"}}"#,
    );
    let root = repo.root();
    let map = JsString::from(repo.package.join("api-map.json").to_str().unwrap());
    let compiler = support::compiler();
    let given = [JsString::from("api")];
    let mut payloads = Vec::new();
    let mut reports = Vec::new();
    let marker = Arc::new(());
    let expected = Arc::clone(&marker);
    let raw = JsString::from_units(
        "  ordinary"
            .encode_utf16()
            .chain([0xd800])
            .chain("\n \t failure\u{85}end  ".encode_utf16())
            .collect(),
    );
    let mut emit = |line: &JsString| {
        payloads.push(line.clone());
        Err(ApiError::Callback(
            ApiCallbackError::new(raw.clone()).with_cause(Cause(Arc::clone(&marker))),
        ))
    };
    let mut report = |line: &JsString| {
        reports.push(line.clone());
        Ok(())
    };
    let outcome = run_api_view_blocking(
        ApiRun {
            host: ApiHost {
                root_absolute: &root,
                given: &given,
                json: false,
                pretty: false,
                emit: &mut emit,
                report: &mut report,
            },
            map_file: &map,
            base: None,
            policy_file: None,
        },
        &compiler,
    )
    .unwrap();
    assert_eq!(outcome.exit, ApiExit::Crash);
    assert_eq!(payloads.len(), 1);
    assert_eq!(payloads[0].units().last(), Some(&10));
    let value = demlik_code_graph::text::JsValue::parse(&payloads[0].to_utf8().unwrap()).unwrap();
    assert_eq!(
        value
            .get("subpaths")
            .unwrap()
            .get(".")
            .unwrap()
            .get("names")
            .unwrap()
            .get("value")
            .unwrap()
            .get("text")
            .unwrap()
            .as_string()
            .unwrap(),
        "export declare const value = 1;"
    );
    let expected_line = JsString::from_units(
        "unexpected error: ordinary"
            .encode_utf16()
            .chain([0xd800])
            .chain(" failure\u{85}end".encode_utf16())
            .collect(),
    );
    assert_eq!(reports, [expected_line]);
    let ApiError::Callback(error) = outcome.failure.unwrap() else {
        panic!("callback failure is retained")
    };
    let cause = error.source().unwrap().downcast_ref::<Cause>().unwrap();
    assert!(Arc::ptr_eq(&expected, &cause.0));
}

#[test]
fn emit_then_report_failure_retains_both_and_report_is_primary() {
    use demlik_code_graph::api::{
        cli::{ApiRun, run_api_view_blocking},
        map::ApiCallbackError,
    };
    let repo = support::Repo::new();
    repo.put("packages/demo/src/index.ts", "export const value = 1;\n");
    repo.put(
        "packages/demo/api-map.json",
        r#"{".":{"entry":"src/index.ts"}}"#,
    );
    let root = repo.root();
    let map = JsString::from(repo.package.join("api-map.json").to_str().unwrap());
    let compiler = support::compiler();
    let given = [JsString::from("api")];
    let first = JsString::from("ApiInputError: this is only a message");
    let second = JsString::from_units(vec![b'r' as u16, 0xdc00]);
    let mut emit = |_: &JsString| Err(ApiError::Callback(ApiCallbackError::new(first.clone())));
    let mut reported = Vec::new();
    let mut report = |line: &JsString| {
        reported.push(line.clone());
        Err(ApiError::Callback(ApiCallbackError::new(second.clone())))
    };
    let error = run_api_view_blocking(
        ApiRun {
            host: ApiHost {
                root_absolute: &root,
                given: &given,
                json: false,
                pretty: false,
                emit: &mut emit,
                report: &mut report,
            },
            map_file: &map,
            base: None,
            policy_file: None,
        },
        &compiler,
    )
    .unwrap_err();
    assert_eq!(
        reported,
        [JsString::from(
            "unexpected error: ApiInputError: this is only a message"
        )]
    );
    assert_eq!(error.message(), second);
    assert!(!error.visible().is_input());
    assert_eq!(error.processing.unwrap().message(), first);
}

#[test]
fn precondition_report_failure_escapes_without_a_processing_failure() {
    use demlik_code_graph::api::map::ApiInputError;
    let root = JsString::from("missing-root");
    let base = JsString::from("HEAD");
    let compiler = TsgoBinary::pinned("missing-compiler");
    let given = [JsString::from("apiBase")];
    let mut emit = |_: &JsString| panic!("must not emit");
    let mut report = |line: &JsString| {
        assert_eq!(line, "--api-base needs --api <map>");
        Err(ApiError::Input(ApiInputError::new(
            "report input failure".into(),
        )))
    };
    let error = run_api_flags_blocking(
        ApiFlags {
            api: None,
            api_base: Some(&base),
            api_policy: None,
        },
        ApiHost {
            root_absolute: &root,
            given: &given,
            json: false,
            pretty: false,
            emit: &mut emit,
            report: &mut report,
        },
        &compiler,
    )
    .unwrap_err();
    assert!(error.processing.is_none());
    assert!(error.visible().is_input());
    assert_eq!(error.message(), "report input failure");
}

#[test]
fn cleanup_input_is_the_visible_refusal_while_both_errors_remain_owned() {
    use demlik_code_graph::api::{
        cli::{ApiRun, run_api_view_blocking},
        map::{ApiCallbackError, ApiInputError},
    };
    let repo = support::Repo::new();
    repo.put("packages/demo/src/index.ts", "export const value = 1;\n");
    repo.put(
        "packages/demo/api-map.json",
        r#"{".":{"entry":"src/index.ts"}}"#,
    );
    let root = repo.root();
    let map = JsString::from(repo.package.join("api-map.json").to_str().unwrap());
    let compiler = support::compiler();
    let given = [JsString::from("api")];
    let mut emit = |_: &JsString| {
        Err(ApiError::OperationAndCleanup {
            operation: Box::new(ApiError::Callback(ApiCallbackError::new(
                "first operation".into(),
            ))),
            cleanup: Box::new(ApiError::Input(ApiInputError::new(
                "cleanup refused".into(),
            ))),
        })
    };
    let mut reports = Vec::new();
    let mut report = |line: &JsString| {
        reports.push(line.clone());
        Ok(())
    };
    let result = run_api_view_blocking(
        ApiRun {
            host: ApiHost {
                root_absolute: &root,
                given: &given,
                json: false,
                pretty: false,
                emit: &mut emit,
                report: &mut report,
            },
            map_file: &map,
            base: None,
            policy_file: None,
        },
        &compiler,
    )
    .unwrap();
    assert_eq!(result.exit, ApiExit::Refused);
    assert_eq!(reports, [JsString::from("cleanup refused")]);
    let ApiError::OperationAndCleanup { operation, cleanup } = result.failure.unwrap() else {
        panic!("keep both")
    };
    assert_eq!(operation.message(), "first operation");
    assert!(cleanup.is_input());
}
