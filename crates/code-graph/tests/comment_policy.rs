use demlik_code_graph::{
    comments::{
        ceilings::{CommentCeilings, ceiling_points, ceilings_from_census, to_points},
        census::load_comment_census,
        ratchet::{CeilingDirection, evaluate_ratchet},
    },
    text::{JsString, JsValue},
};
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn checks_real_scope_ceilings_without_charging_pragmas_or_inherited_object_properties() {
    let root = std::env::temp_dir().join(format!(
        "demlik-comment-policy-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    for (scope, text) in [
        (
            "packages/defaultLow",
            "export function live() {return 1;}\n",
        ),
        ("packages/defaultHigh", "// prose\nexport {};"),
        ("packages/exceeded", "// prose\nexport {};"),
        (
            "packages/slack",
            "// prose\nexport const x=1;\nexport const y=2;",
        ),
        ("__proto__", "// prose\nexport {};"),
        ("toString", "// prose\nexport {};"),
        ("fixtures/example", "// prose\nexport {};"),
    ] {
        let directory = root.join(scope);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("package.json"), "{}").unwrap();
        fs::write(directory.join("entry.ts"), text).unwrap();
    }
    fs::write(
        root.join("packages/defaultLow/only.spec.ts"),
        "// @vitest-environment happy-dom\n",
    )
    .unwrap();
    let census = load_comment_census(
        &root,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    let base = CommentCeilings::parse(
        &JsValue::parse(r#"{"scopes":{"packages/exceeded":40,"packages/slack":60}}"#).unwrap(),
    )
    .unwrap();
    let verdict = evaluate_ratchet(
        &census,
        &base,
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    assert!(!verdict.passed);
    assert_eq!((verdict.scopes_checked, verdict.inherited_scopes), (6, 2));
    assert_eq!(
        verdict
            .violations
            .iter()
            .map(|row| (
                row.scope.to_utf8().unwrap(),
                row.direction,
                row.measured,
                row.ceiling,
                row.delta,
                row.inherited
            ))
            .collect::<Vec<_>>(),
        [
            (
                "packages/defaultHigh".to_owned(),
                CeilingDirection::Exceeded,
                100.0,
                40.0,
                60.0,
                true
            ),
            (
                "packages/exceeded".to_owned(),
                CeilingDirection::Exceeded,
                100.0,
                40.0,
                60.0,
                false
            ),
            (
                "packages/slack".to_owned(),
                CeilingDirection::Slack,
                50.0,
                60.0,
                -10.0,
                false
            ),
        ]
    );
    let recorded = ceilings_from_census(&census, &base);
    assert!(!recorded.scopes.contains_key(&JsString::from("__proto__")));
    assert!(
        !recorded
            .scopes
            .contains_key(&JsString::from("fixtures/example"))
    );
    assert_eq!(recorded.scopes[&JsString::from("packages/defaultLow")], 0.0);
    assert!(
        evaluate_ratchet(
            &census,
            &recorded,
            &demlik_code_graph::project::Collation::try_node22_en_us().unwrap()
        )
        .unwrap()
        .passed
    );
    assert!(to_points(f64::NAN).is_nan());
    assert!(ceiling_points(f64::NAN).is_nan());
    assert_eq!(to_points(-0.00015).to_bits(), (-0.0f64).to_bits());
    assert_eq!(ceiling_points(0.00505), 0.6);
    fs::remove_dir_all(root).unwrap();
}
