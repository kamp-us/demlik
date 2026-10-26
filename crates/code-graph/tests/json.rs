use demlik_code_graph::text::{JsString, JsValue, object_keys};

#[test]
fn keeps_json_parse_values_and_orders_own_keys_like_javascript() {
    let text = r#"{"tail":0,"10":"ten","2":"two","01":1,"4294967295":5,"0":0,"4294967294":4,"__proto__":{"polluted":true},"constructor":1,"\ud800":"\udfff","tail":7,"infinite":1e400,"negative":-0}"#;
    let value = JsValue::parse(text).unwrap();
    let object = value.as_object().unwrap();
    let keys = object_keys(object);
    assert_eq!(
        keys[..4]
            .iter()
            .map(|key| key.to_utf8().unwrap())
            .collect::<Vec<_>>(),
        ["0", "2", "10", "4294967294"]
    );
    assert_eq!(value.get("tail").unwrap().as_number(), Some(7.0));
    assert!(
        value
            .get("infinite")
            .unwrap()
            .as_number()
            .unwrap()
            .is_infinite()
    );
    assert!(
        value
            .get("negative")
            .unwrap()
            .as_number()
            .unwrap()
            .is_sign_negative()
    );
    assert_eq!(
        value
            .get("__proto__")
            .unwrap()
            .get("polluted")
            .unwrap()
            .as_bool(),
        Some(true)
    );
    assert!(value.get("missing").is_none());
    assert_eq!(
        object[&JsString::from_units(vec![0xd800])]
            .as_string()
            .unwrap()
            .units(),
        [0xdfff]
    );
    assert_eq!(
        serde_json::to_string(&value).unwrap(),
        "{\"0\":0,\"2\":\"two\",\"10\":\"ten\",\"4294967294\":4,\"tail\":7,\"01\":1,\"4294967295\":5,\"__proto__\":{\"polluted\":true},\"constructor\":1,\"\\ud800\":\"\\udfff\",\"infinite\":null,\"negative\":0}"
    );
    let invalid = [
        "",
        "undefined",
        "[1,]",
        "{\"x\":1,}",
        "{\"x\":0x2}",
        "{\"x\":+1}",
        "{\"x\":'a'}",
        "{\"x\":\"\\x41\"}",
        "{}[]",
        "\u{feff}{}",
        "[NaN]",
        "[Infinity]",
        "{\"unclosed\":",
    ];
    for text in invalid {
        assert!(JsValue::parse(text).is_err(), "{text:?}");
    }
}

#[test]
fn serializes_ecmascript_number_boundaries_and_deep_valid_json() {
    assert_eq!(
        serde_json::to_string(&JsValue::Number(f64::NAN)).unwrap(),
        "null"
    );
    for (text, expected) in [
        ("1e400", "null"),
        ("-1e400", "null"),
        ("-0", "0"),
        ("1e-7", "1e-7"),
        ("1e-6", "0.000001"),
        ("1e20", "100000000000000000000"),
        ("1e21", "1e+21"),
        ("9007199254740993", "9007199254740992"),
    ] {
        let value = JsValue::parse(text).unwrap();
        assert_eq!(serde_json::to_string(&value).unwrap(), expected, "{text}");
    }
    let text = format!("{}\"\\ud800\"{}", "[".repeat(160), "]".repeat(160));
    assert_eq!(
        serde_json::to_string(&JsValue::parse(&text).unwrap()).unwrap(),
        text
    );
}

#[test]
fn javascript_json_text_keeps_lone_units_without_repairing_invalid_contexts() {
    let mut text = JsString::from("{\"");
    text.extend(&JsString::from_units(vec![0xd800]));
    text.push_str("\":\"");
    text.extend(&JsString::from_units(vec![0xdc00]));
    text.push_str("\"}");
    let value = JsValue::parse_js(&text).unwrap();
    assert_eq!(
        value
            .as_object()
            .unwrap()
            .get(&JsString::from_units(vec![0xd800]))
            .unwrap()
            .as_string()
            .unwrap()
            .units(),
        &[0xdc00]
    );
    let mut invalid = JsString::from("{\"x\":\"\\");
    invalid.extend(&JsString::from_units(vec![0xd800]));
    invalid.push_str("\"}");
    assert!(JsValue::parse_js(&invalid).is_err());
    let mut outside = JsString::from("{}");
    outside.extend(&JsString::from_units(vec![0xdfff]));
    assert!(JsValue::parse_js(&outside).is_err());
    assert_eq!(
        JsValue::parse_js(&"{\"x\":\"𐀀\"}".into())
            .unwrap()
            .get("x")
            .unwrap()
            .as_string()
            .unwrap()
            .units(),
        &[0xd800, 0xdc00]
    );
}
