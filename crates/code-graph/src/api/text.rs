use crate::{
    engine::tsgo::{conflict_marker, conflict_marker_end, line_break},
    extract::functions::js_space,
    render::text::join,
    text::JsString,
};

fn escape_end(text: &[u16], position: usize) -> usize {
    let end = (position + 2).min(text.len());
    if text.get(position + 1) == Some(&13) && text.get(end) == Some(&10) {
        end + 1
    } else {
        end
    }
}
fn quoted_end(text: &[u16], mut position: usize) -> usize {
    let quote = text[position];
    position += 1;
    while let Some(&unit) = text.get(position) {
        match unit {
            92 => position = escape_end(text, position),
            10 | 13 => break,
            unit if unit == quote => {
                position += 1;
                break;
            }
            _ => position += 1,
        }
    }
    position
}
// Returns the end of one raw template chunk and whether it opens a substitution.
fn template_end(text: &[u16], mut position: usize) -> (usize, bool) {
    position += 1;
    while let Some(&unit) = text.get(position) {
        match unit {
            92 => position = escape_end(text, position),
            96 => return (position + 1, false),
            36 if text.get(position + 1) == Some(&123) => return (position + 2, true),
            _ => position += 1,
        }
    }
    (position, false)
}

// Span-only adaptation of the pinned native-preview 7.0.0-dev.20260707.2 scanner:
// dist/ast/scanner.js scanString/scanTemplateAndSetTokenValue (983-1060),
// scan comment/template/nontext/line-separator branches (1316-1763), plus
// api/text.ts nextToken's brace-depth rule. No identifiers, numeric values,
// regex or TypeScript grammar are parsed; the original UTF16 spans are retained.
// Copyright (c) Microsoft Corporation. Apache-2.0; see text/SCANNER-LICENSE.
pub fn without_comments(text: &JsString) -> JsString {
    let units = text.units();
    let mut out = Vec::new();
    let mut position = 0;
    let mut depth = 0i64;
    let mut holes = Vec::new();
    while let Some(&unit) = units.get(position) {
        let start = position;
        match unit {
            47 if units.get(position + 1) == Some(&47) => {
                position += 2;
                while position < units.len() && !line_break(units[position]) {
                    position += 1;
                }
                continue;
            }
            47 if units.get(position + 1) == Some(&42) => {
                position += 2;
                while position < units.len() {
                    if units[position] == 42 && units.get(position + 1) == Some(&47) {
                        position += 2;
                        break;
                    }
                    position += 1;
                }
                continue;
            }
            39 | 34 => position = quoted_end(units, position),
            96 => {
                let (end, substitution) = template_end(units, position);
                position = end;
                if substitution {
                    holes.push(depth);
                }
            }
            123 => {
                depth += 1;
                position += 1;
            }
            125 if holes.last() == Some(&depth) => {
                let (end, substitution) = template_end(units, position);
                position = end;
                if !substitution {
                    holes.pop();
                }
            }
            125 => {
                depth -= 1;
                position += 1;
            }
            60 | 61 | 62 | 124 if conflict_marker(units, position) => {
                position = conflict_marker_end(units, position)
            }
            35 if position == 0 && units.get(1) == Some(&33) => {
                while position < units.len() && !line_break(units[position]) {
                    position += 1;
                }
            }
            // Scanner.scan skips these in its default branch even with skipTrivia=false.
            0x85 | 0x2028 | 0x2029 => {
                position += 1;
                continue;
            }
            // The pinned scanner returns the entire remainder as one nontext token.
            0xfffd => position = units.len(),
            _ => position += 1,
        }
        out.extend_from_slice(&units[start..position]);
    }
    JsString::from_units(out)
}

pub fn tidy_lines(text: &JsString) -> JsString {
    join(
        text.units().split(|unit| *unit == 10).filter_map(|line| {
            let end = line
                .iter()
                .rposition(|unit| !char::from_u32(u32::from(*unit)).is_some_and(js_space))
                .map_or(0, |at| at + 1);
            (end > 0).then(|| JsString::from_units(line[..end].to_vec()))
        }),
        "\n",
    )
}

pub fn statement_of(
    declaration: &crate::engine::tsgo::NativeNode,
) -> Result<crate::engine::tsgo::NativeNode, crate::engine::tsgo::TsgoError> {
    if declaration.is_kind("VariableDeclaration")
        && let Some(list) = declaration.parent()?
        && let Some(statement) = list.parent()?
        && statement.is_kind("VariableStatement")
    {
        return Ok(statement);
    }
    Ok(declaration.clone())
}
pub fn declaration_text(
    statement: &crate::engine::tsgo::NativeNode,
) -> Result<JsString, crate::engine::tsgo::TsgoError> {
    let start = if statement.is_kind("SourceFile") {
        0
    } else {
        statement.start()?
    };
    Ok(tidy_lines(&without_comments(
        &statement
            .source_file()
            .text_slice(start..statement.end()?)?,
    )))
}
