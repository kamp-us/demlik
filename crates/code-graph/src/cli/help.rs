use super::{DefaultValue, OPTION_SPECS};
use crate::{extract::functions::js_space, text::JsString};

// Fixed-command adaptation of Commander 11.1.0 lib/help.js formatHelp and wrap
// (lines 343-468). The descriptions and terms come from the same option owner
// as parsing. Upstream license: COMMANDER-LICENSE in this directory.
pub(super) fn information(width: Option<usize>) -> JsString {
    let width = width.filter(|width| *width != 0).unwrap_or(80);
    let term_width = OPTION_SPECS
        .iter()
        .map(|spec| spec.flags.len())
        .chain(["-h, --help".len(), "path".len()])
        .max()
        .expect("fixed command has options");
    let item = |term: &str, description: &str| {
        let full = format!("{term:term_width$}  {description}");
        let wrapped = wrap(&full, width.saturating_sub(2), term_width + 2);
        wrapped
            .split('\n')
            .map(|line| format!("  {line}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let mut output = format!(
        "Usage: code-graph [options] <path>\n\n{}\n\nArguments:\n{}\n\nOptions:\n",
        wrap(
            "Agent-native TypeScript code-graph tool (SPEC.md)",
            width,
            0
        ),
        item("path", "folder to analyze")
    );
    for spec in OPTION_SPECS {
        let mut description = spec.description.text();
        match spec.default {
            DefaultValue::None => {}
            DefaultValue::Text(value) => {
                description.push_str(&format!(" (default: {value:?})"));
            }
            DefaultValue::EmptyList => description.push_str(" (default: [])"),
        }
        output.push_str(&item(spec.flags, &description));
        output.push('\n');
    }
    output.push_str(&item("-h, --help", "display help for command"));
    output.push('\n');
    output.into()
}

fn wrap(text: &str, width: usize, indent: usize) -> String {
    // All input here is the fixed command's valid Unicode text. Preserve the
    // upstream manual-indent test and use the existing ECMAScript regex engine
    // for its word-break expression, including its zero-width-space behavior.
    if text.as_bytes().windows(2).any(|pair| pair[0] == b'\n') {
        let manual = regress::Regex::new(
            "[\\n][ \\f\\t\\v\u{a0}\u{1680}\u{2000}-\u{200a}\u{202f}\u{205f}\u{3000}\u{feff}]+",
        )
        .expect("fixed Commander manual-indent pattern is valid");
        if manual.find(text).is_some() {
            return text.into();
        }
    }
    let column_width = width.saturating_sub(indent);
    if column_width < 40 {
        return text.into();
    }
    let units = text.encode_utf16().collect::<Vec<_>>();
    let leading = String::from_utf16(&units[..indent]).expect("fixed terms are ASCII");
    let column = String::from_utf16(&units[indent..])
        .expect("fixed descriptions are valid Unicode")
        .replacen("\r\n", "\n", 1);
    let column = column.encode_utf16().collect::<Vec<_>>();
    // A repeat longer than all remaining text has the same matches. Bounding
    // this regex quantifier by its text avoids a backend-sized integer limit.
    let repeat = (column_width - 1).min(column.len().max(1));
    let pattern = format!("\n|.{{1,{repeat}}}([\\s\u{200b}]|$)|[^\\s\u{200b}]+?([\\s\u{200b}]|$)");
    let regex = regress::Regex::new(&pattern).expect("fixed Commander wrap pattern is valid");
    let indent_text = " ".repeat(indent);
    let lines = regex
        .find_from_ucs2(&column, 0)
        .enumerate()
        .map(|(index, found)| {
            let line = String::from_utf16(&column[found.range()])
                .expect("fixed descriptions contain no astral characters");
            if line == "\n" {
                String::new()
            } else {
                format!(
                    "{}{}",
                    if index == 0 { "" } else { &indent_text },
                    line.trim_end_matches(js_space)
                )
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    leading + &lines
}
