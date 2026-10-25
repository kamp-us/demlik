#[path = "../../code-graph/tests/support/api_repo.rs"]
mod support;
use demlik_code_graph::{
    api::{
        diff::{BaseMapStep, prepare_api_diff_with_base_map_blocking},
        map::{ApiCallbackError, ApiError},
        view::PublishedApiOptions,
    },
    text::{JsString, JsValue},
};
use std::{cell::Cell, fs, rc::Rc};

async fn load_base_map(root: &JsString, calls: &Rc<Cell<usize>>) -> Result<JsValue, ApiError> {
    calls.set(calls.get() + 1);
    tokio::task::yield_now().await;
    let mut file = root.clone();
    file.push_str("/api-map.json");
    let bytes = tokio::fs::read(file.to_lossy())
        .await
        .map_err(|source| ApiError::Io { path: file, source })?;
    JsValue::parse(&String::from_utf8_lossy(&bytes)).map_err(|cause| {
        ApiError::Callback(ApiCallbackError::new("base map JSON failed".into()).with_cause(cause))
    })
}
#[test]
fn a_borrowed_local_future_reads_removed_base_subpaths_and_current_tiers_win() {
    let repo = support::Repo::new();
    repo.put("packages/demo/src/index.ts", "export const keep = 1;\n");
    repo.put("packages/demo/src/old.ts", "export const gone = 1;\n");
    repo.put("packages/demo/api-map.json",r#"{".":{"entry":"src/index.ts","tier":"base-old"},"./removed":{"entry":"src/old.ts","tier":"base-only"}}"#);
    let base = repo.commit();
    fs::remove_file(repo.package.join("src/old.ts")).unwrap();
    let root = repo.root();
    let map = JsValue::parse(r#"{".":{"entry":"src/index.ts","tier":"current"}}"#).unwrap();
    let compiler = support::compiler();
    let calls = Rc::new(Cell::new(0));
    let step = prepare_api_diff_with_base_map_blocking(
        &root,
        &map,
        &base,
        &compiler,
        PublishedApiOptions::default(),
    )
    .unwrap();
    let BaseMapStep::Awaiting(request) = step else {
        panic!("base package exists")
    };
    let retained_root = request.root().clone();
    assert!(
        !retained_root
            .to_lossy()
            .starts_with(repo.top.to_str().unwrap())
    );
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let loaded = runtime.block_on(load_base_map(request.root(), &calls));
    let result = request.finish_blocking(loaded).unwrap();
    assert_eq!(calls.get(), 1);
    assert!(!std::path::Path::new(&retained_root.to_lossy()).exists());
    assert_eq!(
        result
            .subpaths
            .keys()
            .map(JsString::to_lossy)
            .collect::<Vec<_>>(),
        [".", "./removed"]
    );
    assert_eq!(
        result.subpaths[&JsString::from(".")].tier.as_ref().unwrap(),
        "current"
    );
    let gone = &result.subpaths[&JsString::from("./removed")];
    assert_eq!(gone.tier.as_ref().unwrap(), "base-only");
    assert_eq!(
        gone.removed[&JsString::from("gone")].before.text,
        "export declare const gone = 1;"
    );
}

#[test]
fn a_base_before_the_package_skips_the_callback_and_each_name_is_added() {
    let repo = support::Repo::new();
    fs::remove_dir_all(&repo.package).unwrap();
    let base = repo.commit();
    repo.put("packages/demo/package.json", "{\"name\":\"demo\"}");
    repo.put(
        "packages/demo/tsconfig.json",
        r#"{"compilerOptions":{"target":"ES2022"},"include":["src"]}"#,
    );
    repo.put("packages/demo/src/index.ts", "export const added = 1;\n");
    let root = repo.root();
    let map = JsValue::parse(r#"{".":{"entry":"src/index.ts"}}"#).unwrap();
    let compiler = support::compiler();
    let calls = Rc::new(Cell::new(0));
    let step = prepare_api_diff_with_base_map_blocking(
        &root,
        &map,
        &base,
        &compiler,
        PublishedApiOptions::default(),
    )
    .unwrap();
    let result = match step {
        BaseMapStep::Complete(diff) => diff,
        BaseMapStep::Awaiting(request) => {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let loaded = runtime.block_on(load_base_map(request.root(), &calls));
            request.finish_blocking(loaded).unwrap()
        }
    };
    assert_eq!(calls.get(), 0);
    assert_eq!(
        result.subpaths[&JsString::from(".")]
            .added
            .keys()
            .map(JsString::to_lossy)
            .collect::<Vec<_>>(),
        ["added"]
    );
}

#[test]
fn unfinished_requests_clean_on_drop_and_explicit_abort_is_fallible() {
    let repo = support::Repo::new();
    repo.put("packages/demo/src/index.ts", "export const value = 1;\n");
    let base = repo.commit();
    let root = repo.root();
    let map = JsValue::parse(r#"{".":{"entry":"src/index.ts"}}"#).unwrap();
    let compiler = support::compiler();
    for explicit in [false, true] {
        let step = prepare_api_diff_with_base_map_blocking(
            &root,
            &map,
            &base,
            &compiler,
            PublishedApiOptions::default(),
        )
        .unwrap();
        let BaseMapStep::Awaiting(request) = step else {
            panic!("base exists")
        };
        let retained = request.root().clone();
        assert!(std::path::Path::new(&retained.to_lossy()).exists());
        if explicit {
            request.abort_blocking().unwrap();
        } else {
            drop(request);
        }
        assert!(!std::path::Path::new(&retained.to_lossy()).exists());
    }
}

#[cfg(unix)]
#[test]
fn a_local_future_rejection_and_real_cleanup_failure_retain_both_causes() {
    use demlik_code_graph::api::base::remove_base_tree;
    use std::{error::Error, fmt, os::unix::fs::PermissionsExt, path::Path, sync::Arc};
    #[derive(Debug)]
    struct Cause(Arc<()>);
    impl fmt::Display for Cause {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("original cause")
        }
    }
    impl Error for Cause {}
    let repo = support::Repo::new();
    repo.put("packages/demo/src/index.ts", "export const value = 1;\n");
    let base = repo.commit();
    let compiler = support::compiler();
    let map = JsValue::parse(r#"{".":{"entry":"src/index.ts"}}"#).unwrap();
    let marker = Arc::new(());
    let calls = Rc::new(Cell::new(0));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    for abort in [false, true] {
        let BaseMapStep::Awaiting(request) = prepare_api_diff_with_base_map_blocking(
            &repo.root(),
            &map,
            &base,
            &compiler,
            PublishedApiOptions::default(),
        )
        .unwrap() else {
            panic!("base exists")
        };
        let root = request.root().clone();
        let path = root.to_lossy();
        let temp: JsString = Path::new(&path)
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_str()
            .unwrap()
            .into();
        let rejection: Result<JsValue, ApiError> = runtime.block_on(async {
            tokio::task::yield_now().await;
            assert!(Path::new(&request.root().to_lossy()).is_dir());
            calls.set(calls.get() + 1);
            fs::set_permissions(&path, fs::Permissions::from_mode(0o555)).unwrap();
            Err(ApiError::Callback(
                ApiCallbackError::new(JsString::from_units(vec![0xd800]))
                    .with_cause(Cause(Arc::clone(&marker))),
            ))
        });
        let error = if abort {
            request.abort_blocking().unwrap_err()
        } else {
            request.finish_blocking(rejection).unwrap_err()
        };
        assert!(Path::new(&path).exists());
        if abort {
            assert!(matches!(error, ApiError::Io { .. }));
        } else {
            let ApiError::OperationAndCleanup { operation, cleanup } = &error else {
                panic!("both failures retained: {error:?}")
            };
            assert_eq!(operation.message().units(), &[0xd800]);
            assert!(matches!(cleanup.as_ref(), ApiError::Io { .. }));
            let cause = operation
                .source()
                .unwrap()
                .downcast_ref::<ApiCallbackError>()
                .unwrap()
                .source()
                .unwrap()
                .downcast_ref::<Cause>()
                .unwrap();
            assert!(Arc::ptr_eq(&marker, &cause.0));
            assert!(std::ptr::eq(error.visible(), cleanup.visible()));
        }
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        remove_base_tree(&temp).unwrap();
        assert!(!Path::new(&temp.to_lossy()).exists());
    }
    assert_eq!(calls.get(), 2);
}
