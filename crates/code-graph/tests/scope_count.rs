use demlik_code_graph::{
    ratchet::scope_count::{ScopeCount, ScopeCountCeilings, evaluate_scope_ratchet},
    text::JsString,
};
struct Directory(std::path::PathBuf);
impl Directory {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        loop {
            let name = format!(
                "demlik-scope-count-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            );
            let path = std::env::temp_dir().join(name);
            match std::fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("create test directory: {error}"),
            }
        }
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0)
            && !std::thread::panicking()
        {
            panic!("remove test directory: {error}");
        }
    }
}

#[test]
fn count_ratchet_requires_exact_ceilings_in_both_directions() {
    let measurements = [("z", 0.0), ("a", 3.0), ("equal", 1.0)].map(|(scope, count)| ScopeCount {
        scope: scope.into(),
        count,
    });
    let ceilings = ScopeCountCeilings {
        default: 1.0,
        scopes: [(JsString::from("z"), 2.0)].into_iter().collect(),
    };
    let verdict = evaluate_scope_ratchet(&measurements, &ceilings);
    assert!(!verdict.passed);
    assert_eq!(verdict.scopes_checked, 3.0);
    assert_eq!(
        serde_json::to_value(&verdict).unwrap(),
        serde_json::json!({"passed":false,"scopesChecked":3,"violations":[{"scope":"a","measured":3,"ceiling":1,"direction":"EXCEEDED","delta":2},{"scope":"z","measured":0,"ceiling":2,"direction":"SLACK","delta":-2}]})
    );
}

#[test]
fn inherited_ceiling_facts_retain_function_omission_object_json_and_table_text() {
    use demlik_code_graph::ratchet::scope_count::{
        CeilingDirection, has_direction, ratchet_table_lines,
    };
    let measurements = ["constructor", "__proto__", "toString"].map(|scope| ScopeCount {
        scope: scope.into(),
        count: 1.0,
    });
    let verdict = evaluate_scope_ratchet(&measurements, &ScopeCountCeilings::default());
    assert!(has_direction(&verdict, CeilingDirection::Slack));
    assert!(!has_direction(&verdict, CeilingDirection::Exceeded));
    let json = serde_json::to_value(&verdict).unwrap();
    assert_eq!(json["violations"][0]["scope"], "__proto__");
    assert_eq!(json["violations"][0]["ceiling"], serde_json::json!({}));
    assert!(json["violations"][1].get("ceiling").is_none());
    assert!(json["violations"][2].get("ceiling").is_none());
    let lines = ratchet_table_lines(&verdict, &"COUNT".into());
    assert!(
        lines[2]
            .to_utf8()
            .unwrap()
            .contains("[object Object]  SLACK")
    );
    assert!(
        lines[3]
            .to_utf8()
            .unwrap()
            .contains("function Object() { [native code] }  SLACK")
    );
}

#[test]
fn ceilings_schema_retains_ordered_issues_and_eager_record_errors() {
    use demlik_code_graph::{ratchet::scope_count::ScopeCountInputError, text::JsValue};
    let input = JsValue::parse(r#"{"default":-0.5,"scopes":{"z":-1,"a":1.5},"extra":0}"#).unwrap();
    let Err(ScopeCountInputError::Issues(issues)) = ScopeCountCeilings::parse(&input) else {
        panic!("malformed ceilings accepted");
    };
    let issues = serde_json::to_value(&issues).unwrap();
    assert_eq!(issues[0]["path"], serde_json::json!(["default"]));
    assert_eq!(
        issues[0]["message"],
        "Invalid input: expected int, received number"
    );
    assert_eq!(issues[1]["path"], serde_json::json!(["scopes", "z"]));
    assert_eq!(issues[1]["message"], "Too small: expected number to be >=0");
    assert_eq!(issues[2]["path"], serde_json::json!(["scopes", "a"]));
    assert_eq!(issues[3]["code"], "unrecognized_keys");
    let eager = JsValue::parse(r#"{"default":-1,"scopes":{"constructor":null}}"#).unwrap();
    assert!(matches!(
        ScopeCountCeilings::parse(&eager),
        Err(ScopeCountInputError::TypeError(_))
    ));
}

#[test]
fn real_ceilings_files_default_refuse_and_parse_without_losing_scope_ownership() {
    use demlik_code_graph::ratchet::scope_count::{
        ScopeCeilingsResolution, read_scope_ceilings, record_scope_ceilings, scopes_under,
    };
    let directory = Directory::new();
    let file = directory.0.join("count.json");
    let text: JsString = file.to_string_lossy().as_ref().into();
    std::fs::write(&file, "bad JSON").unwrap();
    assert!(matches!(
        read_scope_ceilings(&text).unwrap(),
        ScopeCeilingsResolution::Refused { .. }
    ));
    std::fs::write(
        &file,
        r#"{"default":1,"scopes":{"old":2,"services/z":3,"services/a":1}}"#,
    )
    .unwrap();
    let ScopeCeilingsResolution::Resolved(ceilings) = read_scope_ceilings(&text).unwrap() else {
        panic!("valid file refused")
    };
    let mut recorded = record_scope_ceilings(
        &[ScopeCount {
            scope: "services/a".into(),
            count: 4.0,
        }],
        &ceilings,
    );
    assert_eq!(ceilings.scopes[&JsString::from("services/a")], 1.0);
    assert_eq!(recorded.scopes[&JsString::from("old")], 2.0);
    let scopes = ceilings.scopes.keys().cloned().collect::<Vec<_>>();
    let mut selected = scopes_under(&scopes, &"services".into());
    assert_eq!(
        selected,
        vec![JsString::from("services/a"), JsString::from("services/z")]
    );
    selected.clear();
    recorded.scopes.clear();
    assert_eq!(ceilings.scopes.len(), 3);
}
