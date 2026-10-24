use std::fmt;
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::{CommentKind, StringLiteral, TemplateElement};
use oxc_ast_visit::VisitMut;
use oxc_ast_visit::utf8_to_utf16::Utf8ToUtf16;
use oxc_parser::{ParseOptions, Parser};
use oxc_span::SourceType;
use serde::Deserialize;

use crate::syntax::file::{Comment, SyntaxFile, Utf16Field};

#[derive(Debug)]
pub enum ParseFailure {
    Syntax(Vec<String>),
    Representation(serde_json::Error),
}

impl fmt::Display for ParseFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Syntax(diagnostics) => formatter.write_str(&diagnostics.join("\n")),
            Self::Representation(error) => write!(formatter, "cannot read OXC ESTree: {error}"),
        }
    }
}
impl std::error::Error for ParseFailure {}

pub fn parse_type_script(file_name: &Path, text: &str) -> Result<SyntaxFile, ParseFailure> {
    let allocator = Allocator::default();
    let source_type = if file_name.to_string_lossy().ends_with(".tsx") {
        SourceType::tsx()
    } else {
        SourceType::ts()
    }
    .with_module(true);
    let parsed = Parser::new(&allocator, text, source_type)
        .with_options(ParseOptions {
            preserve_parens: true,
            ..ParseOptions::default()
        })
        .parse();
    if !parsed.diagnostics.is_empty() {
        return Err(ParseFailure::Syntax(
            parsed
                .diagnostics
                .into_iter()
                .map(|diagnostic| format!("{diagnostic:?}"))
                .collect(),
        ));
    }
    let mut program = parsed.program;
    Utf8ToUtf16::new(text).convert_program_and_comments(&mut program);
    let units: Vec<u16> = text.encode_utf16().collect();
    let comments = program
        .comments
        .iter()
        .map(|comment| {
            let start = comment.span.start as usize;
            let end = comment.span.end as usize;
            let line = comment.kind == CommentKind::Line;
            Comment {
                start,
                end,
                kind: if line { "Line" } else { "Block" }.into(),
                value: String::from_utf16_lossy(&units[start + 2..end - if line { 0 } else { 2 }]),
            }
        })
        .collect();
    let mut strings = SurrogateStrings::default();
    strings.visit_program(&mut program);
    let json = program.to_estree_json(true, false);
    let mut deserializer = serde_json::Deserializer::from_str(&json);
    deserializer.disable_recursion_limit();
    let tree =
        serde_json::Value::deserialize(&mut deserializer).map_err(ParseFailure::Representation)?;
    Ok(SyntaxFile::from_estree(
        text.to_owned(),
        tree,
        comments,
        strings.fields,
    ))
}

// OXC's documented escape representation survives serde_json's UTF-8 string boundary;
// restore its original UTF-16 values in the owned arena after ESTree serialization.
#[derive(Default)]
struct SurrogateStrings {
    fields: Vec<Utf16Field>,
}

impl<'a> VisitMut<'a> for SurrogateStrings {
    fn visit_string_literal(&mut self, literal: &mut StringLiteral<'a>) {
        if literal.lone_surrogates {
            self.fields.push(Utf16Field {
                kind: "Literal",
                start: literal.span.start as usize,
                end: literal.span.end as usize,
                path: &["value"],
                units: decode_oxc_string(&literal.value),
            });
            literal.lone_surrogates = false;
        }
    }

    fn visit_template_element(&mut self, template: &mut TemplateElement<'a>) {
        if template.lone_surrogates {
            if let Some(cooked) = &template.value.cooked {
                self.fields.push(Utf16Field {
                    kind: "TemplateElement",
                    start: template.span.start as usize - 1,
                    end: template.span.end as usize + if template.tail { 1 } else { 2 },
                    path: &["value", "cooked"],
                    units: decode_oxc_string(cooked),
                });
            }
            template.lone_surrogates = false;
        }
    }
}

fn decode_oxc_string(encoded: &str) -> Vec<u16> {
    let mut chars = encoded.chars();
    let mut units = Vec::new();
    while let Some(character) = chars.next() {
        if character == '\u{fffd}' {
            let mut unit = 0;
            for _ in 0..4 {
                unit = (unit << 4)
                    | chars
                        .next()
                        .and_then(|digit| digit.to_digit(16))
                        .expect("OXC surrogate escape has four hex digits")
                        as u16;
            }
            units.push(unit);
        } else {
            units.extend_from_slice(character.encode_utf16(&mut [0; 2]));
        }
    }
    units
}
