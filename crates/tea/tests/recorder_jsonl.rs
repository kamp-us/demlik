use demlik_tea::persistence::recorder::{
    JsonlError, Recorder, RecorderOptions, StateKind, Trace, TraceStep, parse_jsonl,
    trace_attachment, trace_to_jsonl,
};
use demlik_tea::{
    PlainData,
    data::{JsText, decode_json, stringify_json},
};
use std::sync::Arc;
fn value(text: &str) -> Arc<PlainData> {
    Arc::new(decode_json(text).unwrap())
}
fn kind(value: &PlainData) -> StateKind {
    match value {
        PlainData::Null => StateKind::Null,
        PlainData::Undefined => StateKind::Undefined,
        _ => StateKind::Value,
    }
}
#[test]
fn default_and_full_recordings_emit_exact_source_jsonl_bytes_without_a_tail_newline() {
    for capture_steps in [false, true] {
        let rec = Recorder::with_state_kind(
            RecorderOptions {
                capture_steps,
                ..Default::default()
            },
            || 0.0,
            kind,
        );
        assert!(
            rec.to_jsonl()
                .unwrap_err()
                .to_string()
                .contains("toJSONL() called before any transition")
        );
        rec.record_boot(value(r#"{"n":0}"#));
        rec.record_step(value(r#"{"type":"add","n":1}"#), value(r#"{"n":1}"#));
        rec.record_step(value(r#"{"type":"add","n":2}"#), value(r#"{"n":3}"#));
        let text = rec.to_jsonl().unwrap();
        assert_eq!(
            text,
            format!(
                "{{\"kind\":\"boot\",\"state\":{{\"n\":0}}}}\n{{\"kind\":\"step\",\"msg\":{{\"type\":\"add\",\"n\":1}},\"state\":{}}}\n{{\"kind\":\"step\",\"msg\":{{\"type\":\"add\",\"n\":2}},\"state\":{{\"n\":3}}}}",
                if capture_steps { r#"{"n":1}"# } else { "null" }
            )
        );
        let trace = rec.dump().unwrap();
        let attachment = trace_attachment(&trace).unwrap();
        assert_eq!(attachment.filename, "tea-trace.jsonl");
        assert_eq!(attachment.content_type, "application/x-ndjson");
        assert_eq!(attachment.data, text);
        let parsed = parse_jsonl(&text).unwrap();
        assert_eq!(parsed.msgs.len(), 2);
        assert_eq!(
            parsed.steps.as_ref().unwrap().len(),
            if capture_steps { 2 } else { 1 }
        );
        assert_eq!(stringify_json(&parsed.final_state).unwrap(), r#"{"n":3}"#);
        let steps = parsed.steps.as_ref().unwrap();
        assert!(Arc::ptr_eq(&steps.last().unwrap().msg, &parsed.msgs[1]));
        assert!(Arc::ptr_eq(
            &steps.last().unwrap().state,
            &parsed.final_state
        ));
    }
}
#[test]
fn sparse_step_presence_is_positional_on_write_and_null_tail_keeps_last_known_state() {
    let parsed=parse_jsonl("{\"kind\":\"boot\",\"state\":0}\n{\"kind\":\"step\",\"msg\":1,\"state\":null}\n{\"kind\":\"step\",\"msg\":2,\"state\":2}\n{\"kind\":\"step\",\"msg\":3,\"state\":null}").unwrap();
    assert_eq!(parsed.msgs.len(), 3);
    assert_eq!(parsed.steps.as_ref().unwrap().len(), 1);
    assert!(matches!(
        parsed.final_state.as_ref(),
        PlainData::Number(2.0)
    ));
    assert_eq!(
        trace_to_jsonl(&parsed).unwrap(),
        "{\"kind\":\"boot\",\"state\":0}\n{\"kind\":\"step\",\"msg\":1,\"state\":2}\n{\"kind\":\"step\",\"msg\":2}\n{\"kind\":\"step\",\"msg\":3}"
    );
    let again = parse_jsonl(&trace_to_jsonl(&parsed).unwrap()).unwrap();
    assert!(matches!(again.final_state.as_ref(), PlainData::Undefined));
    let no_steps = Trace {
        loaded: Some(value("0")),
        msgs: vec![value("1")],
        final_state: value("2"),
        steps: Some(Vec::<TraceStep<PlainData, PlainData>>::new()),
    };
    assert_eq!(
        trace_to_jsonl(&no_steps).unwrap(),
        "{\"kind\":\"boot\",\"state\":0}\n{\"kind\":\"step\",\"msg\":1}"
    );
}
#[test]
fn parser_keeps_source_missing_state_rules_utf16_nonfinite_and_javascript_trim() {
    let missing = parse_jsonl("{\"kind\":\"boot\"}").unwrap();
    assert!(matches!(
        missing.loaded.as_deref(),
        Some(PlainData::Undefined)
    ));
    assert!(matches!(missing.final_state.as_ref(), PlainData::Undefined));
    assert!(missing.steps.unwrap().is_empty());
    let text = "\u{feff}\u{a0}{\"kind\":\"boot\",\"state\":{\"\\ud800\":\"\\udc00\",\"n\":1e400}}\u{a0}\r\n \n";
    let parsed = parse_jsonl(text).unwrap();
    let PlainData::Object(state) = parsed.final_state.as_ref() else {
        panic!()
    };
    assert!(
        matches!(state.get(&JsText::from_units(vec![0xd800])),Some(PlainData::String(value)) if value.as_units()==[0xdc00])
    );
    assert!(matches!(state.get("n"),Some(PlainData::Number(number)) if number.is_infinite()));
    assert_eq!(
        trace_to_jsonl(&parsed).unwrap(),
        "{\"kind\":\"boot\",\"state\":{\"\\ud800\":\"\\udc00\",\"n\":null}}"
    );
    assert!(matches!(
        parse_jsonl("\u{85}{\"kind\":\"boot\",\"state\":0}"),
        Err(JsonlError::Syntax { line: 1, .. })
    ));
}
#[test]
fn parser_refusals_preserve_owned_messages_line_numbers_and_actual_native_syntax_causes() {
    let cases = [
        (
            "",
            "tea recorder: parseJSONL found no boot header. A trace must start with { kind: \"boot\", state }.",
        ),
        ("null", "Cannot read properties of null (reading 'kind')"),
        (
            "{}",
            "tea recorder: parseJSONL saw an unknown line kind on line 1: undefined",
        ),
        (
            "\n{\"kind\":\"step\",\"msg\":1,\"state\":2}",
            "tea recorder: parseJSONL saw a step line before the boot header on line 2.",
        ),
        (
            "{\"kind\":\"boot\",\"state\":0}\n\n{\"kind\":\"boot\",\"state\":1}",
            "tea recorder: parseJSONL saw a second boot header on line 3. A trace has exactly one boot line.",
        ),
        (
            "{\"kind\":\"boot\",\"state\":null}",
            "tea recorder: parseJSONL could not determine finalState — the boot state was null and no step carried a non-null state. The trace is unusable for replay.",
        ),
    ];
    for (input, message) in cases {
        let error = match parse_jsonl(input) {
            Ok(_) => panic!("must refuse"),
            Err(error) => error,
        };
        assert_eq!(error.to_string(), message);
        assert_eq!(
            error.name(),
            if input == "null" {
                "TypeError"
            } else {
                "Error"
            }
        );
    }
    let syntax = match parse_jsonl("\n{bad}") {
        Ok(_) => panic!(),
        Err(error) => error,
    };
    assert!(matches!(syntax, JsonlError::Syntax { line: 2, .. }));
    assert!(
        syntax
            .to_string()
            .starts_with("tea recorder: parseJSONL failed on line 2: not valid JSON. ")
    );
    assert!(std::error::Error::source(&syntax).is_some());
}
#[test]
fn jsonl_uses_the_canonical_text_decoder_for_literal_unpaired_values_and_keys() {
    use demlik_tea::persistence::recorder::parse_jsonl_text;
    let mut units = "{\"kind\":\"boot\",\"state\":{\""
        .encode_utf16()
        .collect::<Vec<_>>();
    units.push(0xd800);
    units.extend("\":\"".encode_utf16());
    units.push(0xdc00);
    units.extend("\"}}".encode_utf16());
    let trace = parse_jsonl_text(&JsText::from_units(units)).unwrap();
    assert_eq!(
        trace_to_jsonl(&trace).unwrap(),
        "{\"kind\":\"boot\",\"state\":{\"\\ud800\":\"\\udc00\"}}"
    );
    let mut invalid = "{\"kind\":\"boot\",\"state\":\"\\"
        .encode_utf16()
        .collect::<Vec<_>>();
    invalid.push(0xd800);
    invalid.extend("\"}".encode_utf16());
    assert!(matches!(
        parse_jsonl_text(&JsText::from_units(invalid)),
        Err(JsonlError::Syntax { line: 1, .. })
    ));
}
