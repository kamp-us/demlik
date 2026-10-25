//! The tsconfig caller ignores JSONC diagnostics; Wrangler keeps its strict reader.

use super::{Document, DocumentObject};
use crate::text::{JsString, JsValue};
use biome_json_parser::{JsonParserOptions, parse_json};
use biome_json_syntax::{JsonSyntaxKind as Kind, JsonSyntaxNode};

fn text(node: &JsonSyntaxNode) -> String {
    node.text_trimmed().to_string()
}

fn member(node: &JsonSyntaxNode, object: &mut DocumentObject) {
    let children: Vec<_> = node.children().collect();
    let Some(name) = children.first() else { return };
    if name.kind() != Kind::JSON_MEMBER_NAME {
        return;
    }
    let Some(colon) = node
        .children_with_tokens()
        .filter_map(|part| part.into_token())
        .next()
    else {
        return;
    };
    if colon.kind() != Kind::COLON {
        return;
    }
    let Ok(key) = serde_json::from_str::<JsString>(&text(name)) else {
        return;
    };
    if let Some(value) = children.get(1).and_then(value) {
        object.assign(key, value);
    }
}

fn members(node: &JsonSyntaxNode, object: &mut DocumentObject) {
    for child in node.children() {
        match child.kind() {
            Kind::JSON_MEMBER => member(&child, object),
            Kind::JSON_MEMBER_LIST | Kind::JSON_BOGUS => members(&child, object),
            _ => {}
        }
    }
}

fn value(node: &JsonSyntaxNode) -> Option<Document> {
    if node.kind() == Kind::JSON_ARRAY_VALUE
        && node
            .first_token()
            .is_none_or(|token| token.kind() != Kind::L_BRACK)
    {
        // Biome groups extra root values in a synthetic array. jsonc-parser returns the first.
        return node
            .children()
            .flat_map(|list| list.children())
            .find_map(|child| value(&child));
    }
    let first = node.first_token()?;
    match first.kind() {
        Kind::L_CURLY => {
            let mut object = DocumentObject::new();
            members(node, &mut object);
            Some(Document::Object(object))
        }
        Kind::L_BRACK => Some(Document::Array(
            node.children()
                .flat_map(|list| list.children())
                .filter_map(|child| value(&child))
                .collect(),
        )),
        _ => JsValue::parse(&text(node)).ok().map(Document::Scalar),
    }
}

fn recovered_number(raw: &str) -> Option<JsValue> {
    if !(raw.as_bytes().first().is_some_and(u8::is_ascii_digit)
        || (raw.starts_with('-') && raw.as_bytes().get(1).is_some_and(u8::is_ascii_digit)))
    {
        return None;
    }
    // jsonc-parser scanNumber retains the valid numeric prefix of 1e, 1., and 01.
    // Delegate numeric decoding to the existing owner instead of another number grammar.
    let mut prefix = raw;
    while !prefix.is_empty() {
        if let Ok(value @ JsValue::Number(_)) = JsValue::parse(prefix) {
            return Some(value);
        }
        let (last, _) = prefix.char_indices().next_back()?;
        prefix = &prefix[..last];
    }
    None
}

// jsonc-parser 3.3.1 impl/scanner.js scanString: invalid escapes are consumed without
// appending; an invalid \u consumes only its leading hex digits; raw controls survive.
// Only ERROR_TOKEN string lexemes use this compatibility repair, never JSON grammar.
fn recovered_string(raw: &str) -> JsString {
    let units: Vec<_> = raw.encode_utf16().collect();
    let mut out = Vec::new();
    let mut at = 1;
    while let Some(&unit) = units.get(at) {
        at += 1;
        match unit {
            34 | 10 | 13 => break,
            92 => {
                let Some(&escaped) = units.get(at) else { break };
                at += 1;
                match escaped {
                    34 | 47 | 92 => out.push(escaped),
                    98 => out.push(8),
                    102 => out.push(12),
                    110 => out.push(10),
                    114 => out.push(13),
                    116 => out.push(9),
                    117 => {
                        let mut value = 0;
                        let mut digits = 0;
                        while digits < 4 {
                            let Some(digit) = units
                                .get(at)
                                .and_then(|unit| char::from_u32(u32::from(*unit)))
                                .and_then(|character| character.to_digit(16))
                            else {
                                break;
                            };
                            value = value * 16 + digit as u16;
                            digits += 1;
                            at += 1;
                        }
                        if digits == 4 {
                            out.push(value);
                        }
                    }
                    _ => {}
                }
            }
            _ => out.push(unit),
        }
    }
    JsString::from_units(out)
}

fn repair_tokens(raw: &str, root: &JsonSyntaxNode) -> Option<String> {
    let replacements: Vec<_> = root
        .descendants_with_tokens(biome_rowan::Direction::Next)
        .filter_map(|part| part.into_token())
        .filter(|token| token.kind() == Kind::ERROR_TOKEN)
        .filter_map(|token| {
            let raw = token.text_trimmed();
            let value = if raw.starts_with('"') {
                JsValue::String(recovered_string(raw))
            } else {
                recovered_number(raw)?
            };
            Some((token.text_trimmed_range(), value))
        })
        .collect();
    if replacements.is_empty() {
        return None;
    }
    let mut repaired = raw.to_owned();
    for (range, value) in replacements.into_iter().rev() {
        let encoded = serde_json::to_string(&value).expect("JsValue serialization is infallible");
        repaired.replace_range(
            usize::from(range.start())..usize::from(range.end()),
            &encoded,
        );
    }
    Some(repaired)
}

pub(crate) fn jsonc_recovered(raw: &str) -> Option<Document> {
    let options = JsonParserOptions::default()
        .with_allow_comments()
        .with_allow_trailing_commas();
    let mut parsed = parse_json(raw, options);
    if let Some(repaired) = repair_tokens(raw, &parsed.syntax()) {
        parsed = parse_json(&repaired, options);
    }
    parsed
        .syntax()
        .children()
        .next()
        .and_then(|root| value(&root))
}
