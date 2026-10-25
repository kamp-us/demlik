use demlik_code_graph::{
    api::{
        diff::diff_subpath_names,
        model::{
            ApiDiff, ApiEntryText, ApiReferences, Bump, Changeset, ChangesetBump, ChangesetsSince,
            SubpathNames, VerdictContext,
        },
        ratchet::{text::render_api_ratchet, verdict::ratchet_api_diff},
    },
    text::{JsString, JsValue},
};
use std::sync::Arc;
fn references(rows: &[(&str, &str)]) -> Arc<ApiReferences> {
    Arc::new(
        rows.iter()
            .map(|(key, value)| (JsString::from(*key), JsString::from(*value)))
            .collect(),
    )
}

#[test]
fn ratchet_uses_counted_changesets_and_preserves_missed_facts_and_rules() {
    let old = entry("declare const old: 1;", references(&[]));
    let new = entry(
        "declare const new: 2;",
        references(&[("x#T", "type T = 2;")]),
    );
    let before = [
        ("one".into(), Arc::clone(&old)),
        ("two".into(), Arc::clone(&old)),
    ]
    .into_iter()
    .collect();
    let after = [
        ("two".into(), Arc::clone(&new)),
        ("one".into(), Arc::clone(&new)),
    ]
    .into_iter()
    .collect();
    let subpath = diff_subpath_names(Some(&"stable".into()), &before, &after);
    let diff = ApiDiff {
        root: "/package".into(),
        base: "0123456789abcdef".into(),
        compiler: "native".into(),
        subpaths: [(".".into(), subpath)].into_iter().collect(),
    };
    let policy = JsValue::parse(r#"{"callout":"BREAKING:","tiers":{"stable":{"added":{"bump":"minor"},"changed":{"bump":"major","callout":true},"removed":{"bump":"major"}}}}"#).unwrap();
    let counted = ChangesetsSince {
        package: "pkg".into(),
        changesets: vec![
            Changeset {
                file: "z.md".into(),
                bump: ChangesetBump::Minor,
                body: "normal".into(),
            },
            Changeset {
                file: "a.md".into(),
                bump: ChangesetBump::Patch,
                body: "BREAKING: supplied separately".into(),
            },
        ],
    };
    let verdict = ratchet_api_diff(&diff, &policy, &counted).unwrap();
    assert!(!verdict.passed);
    assert_eq!(verdict.highest_bump, Bump::Minor);
    assert!(verdict.callout_found);
    assert_eq!(
        verdict.changesets,
        vec![JsString::from("a.md"), JsString::from("z.md")]
    );
    assert_eq!(verdict.misses.len(), 2);
    assert!(Arc::ptr_eq(
        &verdict.misses[0].needs,
        &verdict.misses[1].needs
    ));
    assert!(Arc::ptr_eq(
        verdict.misses[0].change.before.as_ref().unwrap(),
        &old
    ));
    assert!(Arc::ptr_eq(
        verdict.misses[1].change.after.as_ref().unwrap(),
        &new
    ));
    assert!(Arc::ptr_eq(
        &verdict.misses[0].change.after.as_ref().unwrap().references,
        &new.references
    ));
    let rendered = render_api_ratchet(
        &verdict,
        &VerdictContext {
            changes: 2.0,
            callout: "BREAKING:".into(),
        },
    );
    assert!(rendered.starts_with("API RATCHET: one in . (stable) changed — needs a major changeset with a \"BREAKING:\" callout; found minor with the callout\n  before:\n    declare const old: 1;\n  after:\n    declare const new: 2;\n    x#T: type T = 2;\n"));
    assert!(
        rendered
            .to_utf8()
            .unwrap()
            .ends_with("API RATCHET: 2 of 2 changes miss their bump against 0123456\n")
    );
}
fn entry(text: &str, refs: Arc<ApiReferences>) -> Arc<ApiEntryText> {
    Arc::new(ApiEntryText {
        text: text.into(),
        references: refs,
    })
}
#[test]
fn diff_retains_shared_entry_and_reference_facts_when_private_types_change() {
    let old = entry(
        "export declare function make(): Options;",
        references(&[("core.d.ts#Options", "type Options = string;")]),
    );
    let new = entry(
        "export declare function make(): Options;",
        references(&[("core.d.ts#Options", "type Options = number;")]),
    );
    let added = entry(
        "export declare const version = 2;",
        Arc::clone(&new.references),
    );
    let removed = entry("export declare const legacy = 1;", references(&[]));
    let before: SubpathNames = [
        ("make".into(), Arc::clone(&old)),
        ("gone".into(), Arc::clone(&removed)),
        (
            "same".into(),
            entry("same", references(&[("b", "2"), ("a", "1")])),
        ),
    ]
    .into_iter()
    .collect();
    let after: SubpathNames = [
        ("make".into(), Arc::clone(&new)),
        ("added".into(), Arc::clone(&added)),
        (
            "same".into(),
            entry("same", references(&[("a", "1"), ("b", "2")])),
        ),
    ]
    .into_iter()
    .collect();
    let diff = diff_subpath_names(Some(&"stable".into()), &before, &after);
    assert_eq!(diff.changed.len(), 1);
    assert_eq!(diff.added.len(), 1);
    assert_eq!(diff.removed.len(), 1);
    assert!(Arc::ptr_eq(
        &diff.changed[&JsString::from("make")].before,
        &old
    ));
    assert!(Arc::ptr_eq(
        &diff.changed[&JsString::from("make")].after,
        &new
    ));
    assert!(Arc::ptr_eq(
        &diff.added[&JsString::from("added")].after,
        &added
    ));
    assert!(Arc::ptr_eq(
        &diff.added[&JsString::from("added")].after.references,
        &new.references
    ));
}

#[test]
fn map_checks_real_package_entries_and_keeps_refusal_categories_and_base_names() {
    use demlik_code_graph::api::map::{ApiError, api_subpaths, base_api_subpaths};
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Files(PathBuf);
    impl Drop for Files {
        fn drop(&mut self) {
            if let Err(error) = fs::remove_dir_all(&self.0)
                && !std::thread::panicking()
            {
                panic!("remove API fixture: {error}");
            }
        }
    }
    let files = Files(loop {
        let path = std::env::temp_dir().join(format!(
            "demlik-api-consumer-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        match fs::create_dir(&path) {
            Ok(()) => break path,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => panic!("create API fixture: {error}"),
        }
    });
    let package = files.0.join("package");
    fs::create_dir(&package).unwrap();
    fs::write(package.join("index.ts"), "export const answer = 42;").unwrap();
    fs::write(package.join("old.d.ts"), "export declare const old: 1;").unwrap();
    fs::write(files.0.join("outside.ts"), "export const outside = 1;").unwrap();
    let root = JsString::from(package.to_str().unwrap());
    let parsed = api_subpaths(
        &root,
        &JsValue::parse(
            r#"{"./second":{"entry":"./index.ts"},".":{"entry":"index.ts","tier":"stable"}}"#,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].subpath, ".");
    assert_eq!(parsed[0].tier.as_ref().unwrap(), "stable");
    assert_eq!(
        parsed[0].entry_absolute,
        package.join("index.ts").to_str().unwrap()
    );
    assert!(parsed[1].tier.is_none());
    let empty = JsValue::parse("{}").unwrap();
    assert!(
        base_api_subpaths(&root, &empty, &"abcdef0123456789".into())
            .unwrap()
            .is_empty()
    );
    let error = api_subpaths(&root, &empty).unwrap_err();
    let ApiError::Input(error) = error else {
        panic!("expected API refusal")
    };
    assert_eq!(error.name(), "ApiInputError");
    assert_eq!(
        error.message(),
        "invalid API map: (root): the API map names no subpath"
    );
    let base = base_api_subpaths(
        &root,
        &JsValue::parse(r#"{".":{"entry":"../outside.ts"}}"#).unwrap(),
        &"abcdef0123456789".into(),
    )
    .unwrap_err();
    let ApiError::Input(base) = base else {
        panic!("expected base-side refusal")
    };
    assert_eq!(
        base.message(),
        "base API map: .: entry ../outside.ts lies outside the package root at the base abcdef012345"
    );
    assert!(
        !base
            .message()
            .to_lossy()
            .contains(package.to_str().unwrap())
    );
    let first = api_subpaths(
        &root,
        &JsValue::parse(r#"{"z":{"entry":"missing.ts"},"a":{"entry":"old.d.ts"}}"#).unwrap(),
    )
    .unwrap_err();
    let ApiError::Input(first) = first else {
        panic!("expected sorted extension refusal")
    };
    assert_eq!(
        first.message(),
        "API map: a: entry old.d.ts is not a .ts, .tsx, .mts or .cts source file"
    );
    let thrown =
        api_subpaths(&root, &JsValue::parse(r#"{"constructor":null}"#).unwrap()).unwrap_err();
    assert!(matches!(thrown, ApiError::TypeError(_)));
}
