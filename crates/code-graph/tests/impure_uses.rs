use demlik_code_graph::{
    boundaries::impure_uses::detect_impure_uses, engine::oxc::parse_type_script,
};
use std::path::Path;

#[test]
fn real_syntax_distinguishes_global_reads_from_type_names_and_bound_parameters() {
    let syntax = parse_type_script(
        Path::new("reads.ts"),
        r#"
        const { stdin: { isTTY } } = process;
        globalThis.process.env.CI;
        new Date();
        type Fetch = typeof fetch;
    "#,
    )
    .unwrap();
    let uses = detect_impure_uses(&syntax);
    assert!(
        uses.iter()
            .any(|item| item.name == "process.stdin" && item.path == ["process", "stdin", "isTTY"])
    );
    assert!(uses.iter().any(|item| item.name == "process.env"));
    assert!(uses.iter().any(|item| item.name == "new Date()"));
    assert!(!uses.iter().any(|item| item.name == "fetch"));
    let bound = parse_type_script(
        Path::new("bound.ts"),
        "function injected(fetch: unknown) {} function other() { fetch('url'); }",
    )
    .unwrap();
    assert!(detect_impure_uses(&bound).is_empty());
}
