use crate::text::JsString;

pub(crate) fn pad_start(value: &str, width: usize) -> String {
    format!(
        "{}{value}",
        " ".repeat(width.saturating_sub(value.encode_utf16().count()))
    )
}
pub(crate) fn pad_end(value: &str, width: usize) -> String {
    format!(
        "{value}{}",
        " ".repeat(width.saturating_sub(value.encode_utf16().count()))
    )
}
pub(crate) fn pad_end_units(value: &JsString, width: usize) -> JsString {
    let mut out = value.clone();
    out.push_str(&" ".repeat(width.saturating_sub(value.units().len())));
    out
}
pub(crate) fn join(parts: impl IntoIterator<Item = JsString>, separator: &str) -> JsString {
    let mut out = JsString::default();
    for (index, part) in parts.into_iter().enumerate() {
        if index > 0 {
            out.push_str(separator);
        }
        out.extend(&part);
    }
    out
}
pub(crate) fn fixed(value: f64, digits: u8) -> String {
    ryu_js::Buffer::new().format_to_fixed(value, digits).into()
}
pub(crate) fn number(value: f64) -> String {
    ryu_js::Buffer::new().format(value).into()
}
pub(crate) fn grouped(value: usize) -> String {
    let text = value.to_string();
    let mut out = String::new();
    for (index, character) in text.chars().enumerate() {
        if index > 0 && (text.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(character);
    }
    out
}
