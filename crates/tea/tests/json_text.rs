use demlik_tea::{
    PlainData,
    data::{JsText, decode_json, decode_json_text, stringify_json},
};
#[test]
fn literal_unpaired_values_and_keys_preserve_exact_utf16_units() {
    let value = decode_json_text(&JsText::from_units(vec![34, 55296, 34])).unwrap();
    assert!(matches!(&value,PlainData::String(value) if value.as_units()==[55296]));
    assert_eq!(stringify_json(&value).unwrap(), r#""\ud800""#);
    let key = decode_json_text(&JsText::from_units(vec![123, 34, 55296, 34, 58, 49, 125])).unwrap();
    let PlainData::Object(fields) = &key else {
        panic!()
    };
    assert!(matches!(
        fields.get(&JsText::from_units(vec![55296])),
        Some(PlainData::Number(1.0))
    ));
    assert_eq!(stringify_json(&key).unwrap(), r#"{"\ud800":1}"#);
    let slash = decode_json_text(&JsText::from_units(vec![34, 92, 92, 55296, 34])).unwrap();
    assert!(matches!(slash,PlainData::String(value) if value.as_units()==[92,55296]));
    let pair = decode_json_text(&JsText::from_units(vec![34, 55296, 56320, 34])).unwrap();
    assert!(matches!(pair,PlainData::String(value) if value.as_utf8()==Some("𐀀")));
}
#[test]
fn invalid_unpaired_placement_is_not_repaired_into_accepted_json() {
    for units in [
        vec![34, 92, 55296, 34],
        vec![55296],
        vec![56320],
        vec![123, 55296, 58, 49, 125],
    ] {
        let error = match decode_json_text(&JsText::from_units(units)) {
            Ok(_) => panic!("must reject invalid UTF16 placement"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("unpaired UTF-16 code unit"));
    }
    for text in [
        "null",
        "[true,1e400,-0]",
        r#"{"a":"value","a":2,"\ud800":"\udc00"}"#,
        "{bad}",
        r#""\q""#,
    ] {
        let owned = decode_json_text(&JsText::from(text));
        let original = decode_json(text);
        assert_eq!(owned.is_ok(), original.is_ok());
        match (owned, original) {
            (Ok(owned), Ok(original)) => {
                assert_eq!(stringify_json(&owned), stringify_json(&original))
            }
            (Err(owned), Err(original)) => assert_eq!(owned.to_string(), original.to_string()),
            _ => unreachable!(),
        }
    }
}
