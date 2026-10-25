use crate::{
    engine::oxc::{ParseFailure, parse_snippet},
    extract::functions::js_space,
    syntax::file::NodeRef,
    text::{JsRegex, JsString},
};
use serde::{Serialize, Serializer, ser::SerializeMap};
use std::{
    ops::{Index, IndexMut},
    sync::LazyLock,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
#[repr(usize)]
pub enum CommentBucket {
    Pragma,
    License,
    Marker,
    CommentedOutCode,
    Banner,
    FileHeader,
    Docblock,
    Block,
    Inline,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CommentClass {
    Protected,
    Mechanical,
    Prose,
}
impl CommentBucket {
    pub const ALL: [Self; 9] = [
        Self::Pragma,
        Self::License,
        Self::Marker,
        Self::CommentedOutCode,
        Self::Banner,
        Self::FileHeader,
        Self::Docblock,
        Self::Block,
        Self::Inline,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pragma => "pragma",
            Self::License => "license",
            Self::Marker => "marker",
            Self::CommentedOutCode => "commented-out-code",
            Self::Banner => "banner",
            Self::FileHeader => "file-header",
            Self::Docblock => "docblock",
            Self::Block => "block",
            Self::Inline => "inline",
        }
    }
    pub fn class(self) -> CommentClass {
        match self {
            Self::Pragma | Self::License | Self::Marker => CommentClass::Protected,
            Self::CommentedOutCode | Self::Banner => CommentClass::Mechanical,
            Self::FileHeader | Self::Docblock | Self::Block | Self::Inline => CommentClass::Prose,
        }
    }
}
pub fn buckets_in(class: CommentClass) -> impl Iterator<Item = CommentBucket> {
    CommentBucket::ALL
        .into_iter()
        .filter(move |bucket| bucket.class() == class)
}
#[derive(Debug)]
pub struct BucketRecord<T>([T; CommentBucket::ALL.len()]);
impl<T> BucketRecord<T> {
    pub fn new(mut make: impl FnMut() -> T) -> Self {
        Self(std::array::from_fn(|_| make()))
    }
}
impl<T> Index<CommentBucket> for BucketRecord<T> {
    type Output = T;
    fn index(&self, index: CommentBucket) -> &Self::Output {
        &self.0[index as usize]
    }
}
impl<T> IndexMut<CommentBucket> for BucketRecord<T> {
    fn index_mut(&mut self, index: CommentBucket) -> &mut Self::Output {
        &mut self.0[index as usize]
    }
}
impl<T: Serialize> Serialize for BucketRecord<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(CommentBucket::ALL.len()))?;
        for bucket in CommentBucket::ALL {
            map.serialize_entry(bucket.as_str(), &self[bucket])?;
        }
        map.end()
    }
}
fn pattern(source: &str) -> JsRegex {
    JsRegex::new(&source.into()).expect("static comment pattern is valid ECMAScript")
}
static PRAGMA: LazyLock<JsRegex> = LazyLock::new(|| {
    pattern(
        r"(@ts-(expect-error|ignore|nocheck)|biome-ignore|eslint-(disable|enable)|prettier-ignore|oxlint-disable|(c8|v8|istanbul) ignore|@vitest-environment|@jsxImportSource|<reference\s)",
    )
});
static LICENSE: LazyLock<JsRegex> =
    LazyLock::new(|| pattern(r"(Copyright|SPDX-License-Identifier|Licensed under)"));
static MARKER: LazyLock<JsRegex> =
    LazyLock::new(|| pattern(r"(\b(TODO|FIXME|HACK|XXX)\b|@deprecated\b)"));
static BANNER_PUNCTUATION_ONLY: LazyLock<JsRegex> = LazyLock::new(|| pattern(r"^[-=*_#~+ ]+$"));
static BANNER_RULE: LazyLock<JsRegex> = LazyLock::new(|| pattern(r"^[-=*_#~]{3,}"));
static BANNER_DIVIDER: LazyLock<JsRegex> =
    LazyLock::new(|| pattern(r"^[-=*_#~ ]{2,}\s*\S[\s\S]*?\s*[-=*_#~ ]{2,}$"));
static CODE_TAIL: LazyLock<JsRegex> = LazyLock::new(|| pattern(r"[;{},)]$"));
static CODE_HEAD: LazyLock<JsRegex> = LazyLock::new(|| {
    pattern(
        r"^(const|let|var|return|if|else|for|while|switch|import|export|await|async|function|class|type|interface|enum|throw|new)\b|^[})]|^<\/?[A-Z]",
    )
});

fn whitespace(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(js_space)
}
fn trim_end(units: &[u16]) -> &[u16] {
    let end = units
        .iter()
        .rposition(|unit| !whitespace(*unit))
        .map_or(0, |last| last + 1);
    &units[..end]
}
fn trim(units: &[u16]) -> &[u16] {
    let units = trim_end(units);
    let start = units
        .iter()
        .position(|unit| !whitespace(*unit))
        .unwrap_or(units.len());
    &units[start..]
}
pub fn comment_body(text: &JsString) -> JsString {
    let units = text.units();
    if let Some(body) = units.strip_prefix(&[47, 47]) {
        return JsString::from_units(trim(body).to_vec());
    }
    let body = units
        .strip_prefix(&[47, 42, 42])
        .or_else(|| units.strip_prefix(&[47, 42]))
        .unwrap_or(units);
    let body = body.strip_suffix(&[42, 47]).unwrap_or(body);
    let mut out = Vec::new();
    for (index, line) in body.split(|unit| *unit == 10).enumerate() {
        if index > 0 {
            out.push(10);
        }
        let start = line
            .iter()
            .position(|unit| !whitespace(*unit))
            .unwrap_or(line.len());
        let line = if line.get(start) == Some(&42) && line.get(start + 1) != Some(&47) {
            let after_star = start + 1;
            let after_space =
                after_star + usize::from(matches!(line.get(after_star), Some(32 | 9)));
            &line[after_space..]
        } else {
            line
        };
        out.extend_from_slice(trim_end(line));
    }
    JsString::from_units(trim(&out).to_vec())
}
fn lone_literal(statements: &[NodeRef<'_>]) -> bool {
    let [statement] = statements else {
        return false;
    };
    if statement.kind() != "ExpressionStatement" {
        return false;
    }
    let Some(expression) = statement.node("expression") else {
        return false;
    };
    match expression.kind() {
        "Identifier" => true,
        "Literal" => expression.string_units("value").is_some(),
        "TemplateLiteral" => expression.nodes("expressions").is_empty(),
        _ => false,
    }
}
fn code_statements(statements: &[NodeRef<'_>]) -> bool {
    !statements.is_empty() && !lone_literal(statements)
}
pub fn is_commented_out_code(body: &JsString) -> Result<bool, ParseFailure> {
    if !CODE_TAIL.test(body) && !CODE_HEAD.test(body) {
        return Ok(false);
    }
    if let Some(syntax) = parse_snippet(&body.to_lossy())? {
        return Ok(code_statements(&syntax.root().nodes("body")));
    }
    let wrapped = format!("function snippet() {{\n{}\n}}", body.to_lossy());
    let Some(syntax) = parse_snippet(&wrapped)? else {
        return Ok(false);
    };
    let statements = syntax.root().nodes("body");
    let Some(function) = statements
        .first()
        .filter(|node| node.kind() == "FunctionDeclaration")
    else {
        return Ok(false);
    };
    Ok(function
        .node("body")
        .is_some_and(|body| code_statements(&body.nodes("body"))))
}
pub fn is_banner(body: &JsString) -> bool {
    !body.is_empty()
        && (BANNER_PUNCTUATION_ONLY.test(body)
            || BANNER_RULE.test(body)
            || BANNER_DIVIDER.test(body))
}
pub struct CommentShape<'a> {
    pub text: &'a JsString,
    pub pos: usize,
    pub file_header_candidate: bool,
}
pub fn classify_comment(shape: CommentShape<'_>) -> Result<CommentBucket, ParseFailure> {
    let body = comment_body(shape.text);
    if PRAGMA.test(&body) {
        return Ok(CommentBucket::Pragma);
    }
    if shape.pos == 0 && LICENSE.test(&body) {
        return Ok(CommentBucket::License);
    }
    if MARKER.test(&body) {
        return Ok(CommentBucket::Marker);
    }
    if is_commented_out_code(&body)? {
        return Ok(CommentBucket::CommentedOutCode);
    }
    if is_banner(&body) {
        return Ok(CommentBucket::Banner);
    }
    if !shape.text.starts_with("/*") {
        return Ok(CommentBucket::Inline);
    }
    if shape.file_header_candidate {
        return Ok(CommentBucket::FileHeader);
    }
    Ok(if shape.text.starts_with("/**") {
        CommentBucket::Docblock
    } else {
        CommentBucket::Block
    })
}
