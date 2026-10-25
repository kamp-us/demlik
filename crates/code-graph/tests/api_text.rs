use demlik_code_graph::{
    api::text::{tidy_lines, without_comments},
    text::JsString,
};
#[test]
fn declaration_cleanup_removes_comments_but_keeps_template_and_quoted_text() {
    let text = JsString::from(
        "export interface Shape {\r\n    /** The side. */\r\n    readonly side: number; // trailing\r\n    readonly /* inline */ corner: Corner;\r\n}\r\n\r\ntype Url = `https://${Host}/${\"/* x */\"}`; // gone\n",
    );
    assert_eq!(
        tidy_lines(&without_comments(&text)),
        JsString::from(
            "export interface Shape {\n    readonly side: number;\n    readonly  corner: Corner;\n}\ntype Url = `https://${Host}/${\"/* x */\"}`;"
        )
    );
}

#[test]
fn scanner_skips_bare_nel_but_preserves_it_inside_a_quoted_token() {
    let text = JsString::from("\u{85}// gone\n type X = \"\u{85}/*keep*/\"; /* tail */\u{85}");
    assert_eq!(
        without_comments(&text),
        JsString::from("\n type X = \"\u{85}/*keep*/\"; ")
    );
}
