#[path = "support/api_repo.rs"]
mod support;
use demlik_code_graph::{
    api::{diff::diff_published_api_blocking, view::PublishedApiOptions},
    text::{JsString, JsValue},
};
use std::{cell::RefCell, rc::Rc};
#[test]
fn actual_compiler_diffs_dirty_working_files_against_git_without_changing_the_checkout() {
    let repo = support::Repo::new();
    repo.put("packages/demo/src/index.ts","export function parse(text: string) { return Number(text); }\nexport const keep = 1;\nexport function legacy() {}\n");
    let base = repo.commit();
    repo.put("packages/demo/src/index.ts","export function parse(text: string, radix?: number) { return Number.parseInt(text, radix); }\nexport const keep = 1;\nexport function extra() { return 'x'; }\n");
    let before = repo.state();
    let compiler = support::compiler();
    let warnings = Rc::new(RefCell::new(Vec::new()));
    let original = Rc::clone(&warnings);
    let mut warn = |line: &demlik_code_graph::text::JsString| {
        original.borrow_mut().push(line.clone());
        Ok(())
    };
    let map = JsValue::parse(r#"{".":{"entry":"src/index.ts","tier":"stable"}}"#).unwrap();
    let diff = diff_published_api_blocking(
        &repo.root(),
        &map,
        &base,
        &compiler,
        PublishedApiOptions {
            repo_root: None,
            warn: Some(&mut warn),
        },
    )
    .unwrap();
    assert_eq!(diff.base, base);
    assert_eq!(diff.compiler, compiler.version());
    assert!(warnings.borrow().is_empty());
    let part = &diff.subpaths[&JsString::from(".")];
    assert_eq!(part.tier.as_ref().unwrap(), "stable");
    assert_eq!(
        part.added
            .keys()
            .map(|key| key.to_lossy())
            .collect::<Vec<_>>(),
        ["extra"]
    );
    assert_eq!(
        part.removed
            .keys()
            .map(|key| key.to_lossy())
            .collect::<Vec<_>>(),
        ["legacy"]
    );
    assert_eq!(
        part.changed
            .keys()
            .map(|key| key.to_lossy())
            .collect::<Vec<_>>(),
        ["parse"]
    );
    assert_eq!(
        part.changed[&JsString::from("parse")].before.text,
        "export declare function parse(text: string): number;"
    );
    assert_eq!(
        part.changed[&JsString::from("parse")].after.text,
        "export declare function parse(text: string, radix?: number): number;"
    );
    assert_eq!(repo.state(), before);
}

#[test]
fn both_sides_call_the_same_borrowed_warning_capture_in_order() {
    let repo = support::Repo::new();
    repo.put(
        "packages/demo/src/index.ts",
        "export const bad: string = 1;\n",
    );
    let base = repo.commit();
    repo.put(
        "packages/demo/src/index.ts",
        "export const bad: string = 2;\n",
    );
    let original = Rc::new(RefCell::new(Vec::<JsString>::new()));
    let retained = Rc::clone(&original);
    let mut warn = |message: &JsString| {
        retained.borrow_mut().push(message.clone());
        Ok(())
    };
    let compiler = support::compiler();
    diff_published_api_blocking(
        &repo.root(),
        &JsValue::parse(r#"{".":{"entry":"src/index.ts"}}"#).unwrap(),
        &base,
        &compiler,
        PublishedApiOptions {
            repo_root: None,
            warn: Some(&mut warn),
        },
    )
    .unwrap();
    let messages = original.borrow();
    assert_eq!(messages.len(), 2);
    assert_eq!(
        messages[0],
        "code-graph: warning: tsgo reported 1 diagnostic(s); the declarations were emitted anyway"
    );
    assert_eq!(
        messages[1],
        JsString::from(format!(
            "code-graph: warning: tsgo reported 1 diagnostic(s) at the base {}; the declarations were emitted anyway",
            &base.to_lossy()[..12]
        ))
    );
    assert_eq!(Rc::strong_count(&original), 2);
}
