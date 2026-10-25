use demlik_code_graph::comments::census::load_comment_census;
use serde_json::json;
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn counts_real_comment_lines_once_and_groups_them_under_the_nearest_package() {
    let root = std::env::temp_dir().join(format!(
        "demlik-comments-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    for (file, text) in [
        (
            "main.ts",
            "/* Copyright 2026 */\n// @ts-ignore\n// TODO keep this marker\n// const dead = 1;\n// ---- Types ----\nimport './other';\n/**\n * Documents one call.\n */\nexport function run() {\n  /* a plain block */ return 1; // a reason\n}\n// ordinary prose\n",
        ),
        ("empty.ts", ""),
        ("broken.ts", "export function broken( {"),
        ("pkg/package.json", "{}"),
        (
            "pkg/src/other.ts",
            "/**\n * Describes this file.\n */\nexport type Config = {flag: boolean};\n",
        ),
        (
            "pkg/src/other.spec.ts",
            "// @vitest-environment happy-dom\n",
        ),
        ("pkg/nested/package.json", "{}"),
        (
            "pkg/nested/src/entry.ts",
            "export function own() {return 1;}\n",
        ),
    ] {
        let absolute = root.join(file);
        fs::create_dir_all(absolute.parent().unwrap()).unwrap();
        fs::write(absolute, text).unwrap();
    }
    let census = load_comment_census(&root).unwrap();
    let value = serde_json::to_value(census).unwrap();
    assert_eq!(
        value["totals"],
        json!({"files":5,"loc":24,"codeLines":5,"blankLines":5,"commentLines":14,"mechanicalLines":2,"protectedLines":4,"proseLines":8,"ratio":2.8})
    );
    assert_eq!(
        value["scopes"],
        json!([
            {"scope":".","files":2,"loc":15,"codeLines":3,"commentLines":10,"mechanicalLines":2,"protectedLines":3,"proseLines":5,"ratio":3.333},
        {"scope":"pkg","files":2,"loc":7,"codeLines":1,"commentLines":4,"mechanicalLines":0,"protectedLines":1,"proseLines":3,"ratio":4.0},
        {"scope":"pkg/nested","files":1,"loc":2,"codeLines":1,"commentLines":0,"mechanicalLines":0,"protectedLines":0,"proseLines":0,"ratio":0.0}
        ])
    );
    assert_eq!(
        value["files"][0]["buckets"],
        json!({"pragma":1,"license":1,"marker":1,"commented-out-code":1,"banner":1,"file-header":0,"docblock":3,"block":1,"inline":1})
    );
    assert_eq!(
        value["buckets"]["inline"],
        json!({"lines":1,"count":2,"files":1})
    );
    assert_eq!(
        value["buckets"]["file-header"],
        json!({"lines":3,"count":1,"files":1})
    );
    assert_eq!(value["files"][2]["isTest"], true);
    fs::remove_dir_all(root).unwrap();
}
