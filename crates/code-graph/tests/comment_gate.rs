use demlik_code_graph::comments::gate::{CommentGateArgs, run_comment_gate};
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn records_real_ceilings_then_reports_ci_pass_fail_and_config_refusal() {
    let root = std::env::temp_dir().join(format!(
        "demlik-comment-gate-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    for (scope, source) in [
        (
            "packages/a",
            "// prose\nexport const x=1;\nexport const y=2;\n",
        ),
        ("packages/b", "// prose\nexport {};\n"),
        (
            "fixtures/example",
            "// ignored by the ratchet\nexport {};\n",
        ),
    ] {
        let path = root.join(scope);
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("package.json"), "{}").unwrap();
        fs::write(path.join("entry.ts"), source).unwrap();
    }
    let args = CommentGateArgs {
        root_absolute: &root,
        repo_root: &root,
        ci: false,
        write_ceilings: true,
        json: false,
        pretty: false,
    };
    let recorded = run_comment_gate(args).unwrap();
    assert_eq!(recorded.exit_code, 0);
    assert!(recorded.reports.is_empty());
    let file = root.join("comment-ceilings.json");
    let first = fs::read_to_string(&file).unwrap();
    assert_eq!(
        first,
        "{\n  \"default\": 40,\n  \"scopes\": {\n    \"packages/a\": 50,\n    \"packages/b\": 100\n  },\n  \"slackPoints\": 2\n}\n"
    );
    let pass = run_comment_gate(CommentGateArgs {
        ci: true,
        write_ceilings: false,
        ..args
    })
    .unwrap();
    assert_eq!(pass.exit_code, 0);
    assert_eq!(
        pass.emitted[0],
        "comment ratchet: PASS — 2 scope(s) within ceiling (0 on the 40.0% default, slack 2 pts).\n"
    );
    assert_eq!(
        run_comment_gate(CommentGateArgs {
            ci: true,
            json: true,
            ..args
        })
        .unwrap()
        .exit_code,
        0
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), first);
    fs::write(
        root.join("packages/a/entry.ts"),
        "// prose\n// more prose\nexport const x=1;\nexport const y=2;\n",
    )
    .unwrap();
    let fail = run_comment_gate(CommentGateArgs {
        ci: true,
        write_ceilings: false,
        json: true,
        ..args
    })
    .unwrap();
    assert_eq!(fail.exit_code, 1);
    assert!(fail.reports.is_empty());
    assert!(
        fail.emitted[0]
            .to_utf8()
            .unwrap()
            .contains("\"direction\":\"EXCEEDED\"")
    );
    fs::write(&file, "{").unwrap();
    let refused = run_comment_gate(CommentGateArgs {
        ci: true,
        write_ceilings: false,
        ..args
    })
    .unwrap();
    assert_eq!(refused.exit_code, 2);
    assert!(refused.emitted.is_empty());
    assert_eq!(
        refused.reports[0],
        format!("config file \"{}\" is not valid JSON.", file.display())
    );
    let census = run_comment_gate(CommentGateArgs {
        write_ceilings: false,
        ..args
    })
    .unwrap();
    assert_eq!(census.exit_code, 0);
    assert!(census.reports.is_empty());
    assert!(census.emitted[0].starts_with("comment census:"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn stable_json_formats_nested_lossless_keys_without_turning_containers_into_raw_subtrees() {
    use demlik_code_graph::{render::json::stable_stringify, text::JsValue};
    let value=JsValue::parse(r#"{"z":[{"\ud800":{"2":-0,"10":1e400,"__proto__":{"unsafe":true},"a":"\udfff"}}],"a":[],"__proto__":{"x":1}}"#).unwrap();
    assert_eq!(
        stable_stringify(&value, false).unwrap(),
        r#"{"a":[],"z":[{"\ud800":{"2":0,"10":null,"a":"\udfff"}}]}"#
    );
    assert_eq!(
        stable_stringify(&value, true).unwrap(),
        "{\n  \"a\": [],\n  \"z\": [\n    {\n      \"\\ud800\": {\n        \"2\": 0,\n        \"10\": null,\n        \"a\": \"\\udfff\"\n      }\n    }\n  ]\n}"
    );
}
