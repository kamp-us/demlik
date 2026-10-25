use demlik_code_graph::{
    api::{model::Bump, ratchet::changesets::parse_changeset},
    text::JsString,
};

#[test]
fn parses_ordered_bumps_overwriting_values_and_preserving_the_exact_body() {
    let parsed = parse_changeset(&JsString::from(
        "\u{feff}---\r\n\"@demo/pkg\": minor\r\n'__proto__': patch\r\n@demo/pkg: major\r\n---\r\n\r\nBody\r\n---\r\nlast\r",
    )).unwrap();
    assert_eq!(
        parsed
            .bumps
            .keys()
            .map(JsString::to_lossy)
            .collect::<Vec<_>>(),
        ["@demo/pkg", "__proto__"]
    );
    assert_eq!(parsed.bumps[&JsString::from("@demo/pkg")], Bump::Major);
    assert_eq!(parsed.bumps[&JsString::from("__proto__")], Bump::Patch);
    assert_eq!(parsed.body, "\nBody\n---\nlast\r");
}

#[test]
fn raw_names_and_body_keep_lone_utf16_units_without_yaml_unescaping() {
    let mut units = "---\n\"".encode_utf16().collect::<Vec<_>>();
    units.push(0xd800);
    units.extend("\": patch\n---\n".encode_utf16());
    units.push(0xdc00);
    let parsed = parse_changeset(&JsString::from_units(units)).unwrap();
    assert_eq!(
        parsed.bumps[&JsString::from_units(vec![0xd800])],
        Bump::Patch
    );
    assert_eq!(parsed.body.units(), [0xdc00]);
    let literal = parse_changeset(&"---\n\"\\ud800\": none\n---\n".into()).unwrap();
    assert_eq!(literal.bumps[&JsString::from("\\ud800")], Bump::None);
    for text in [
        " ---\na: patch\n---\n",
        "---\na: PATCH\n---\n",
        "---\na: patch # note\n---\n",
        "---\na: minor\n",
        "---\n\"\": patch\n---\n",
        "\u{feff}\u{feff}---\n---\n",
    ] {
        assert!(
            parse_changeset(&text.into()).is_none(),
            "must refuse {text:?}"
        );
    }
}
