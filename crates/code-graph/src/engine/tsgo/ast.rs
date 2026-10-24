use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::LazyLock;

use super::TsgoError;

const NODE_LEN: usize = 28;
const LOW_DATA: u32 = 0x00ff_ffff;
const IDENTIFIER: u32 = 79;
const STRING_LITERAL: u32 = 10;
const IMPORT_DECLARATION: u32 = 273;
const SOURCE_FILE: u32 = 307;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    native_preview_version: String,
    protocol_version: u32,
    kinds: HashMap<String, u32>,
    kind_names: HashMap<u32, String>,
    node_flags: HashMap<String, u32>,
    child_properties: HashMap<u32, Vec<String>>,
    statement_kinds: HashSet<u32>,
}
static METADATA: LazyLock<Metadata> = LazyLock::new(|| {
    let metadata: Metadata = serde_json::from_str(include_str!("ast_7_0_20260707_2.json"))
        .expect("checked-in native AST metadata is valid JSON");
    assert_eq!(metadata.native_preview_version, super::NATIVE_PREVIEW_PIN);
    assert_eq!(metadata.protocol_version, 5);
    metadata
});
pub(super) fn is_kind(kind: u32, name: &str) -> bool {
    METADATA.kinds.get(name) == Some(&kind)
}
pub(super) fn kind_named(name: &str) -> Option<u32> {
    METADATA.kinds.get(name).copied()
}
pub(super) fn flag_named(name: &str) -> Option<u32> {
    METADATA.node_flags.get(name).copied()
}
pub(super) fn is_statement(kind: u32) -> bool {
    METADATA.statement_kinds.contains(&kind)
}
pub(super) fn kind_name(kind: u32) -> Option<&'static str> {
    METADATA.kind_names.get(&kind).map(String::as_str)
}

#[derive(Clone, Copy)]
pub(super) struct Node {
    pub index: u32,
    pub kind: u32,
    pub pos: i32,
    pub end: i32,
    pub next: u32,
    pub parent: u32,
    pub data: u32,
    pub flags: u32,
}

pub(super) struct SourceFile {
    bytes: Vec<u8>,
    nodes: usize,
    strings: usize,
    string_offsets: usize,
    extended: usize,
    pub file_name: PathBuf,
    pub path: String,
    text: Vec<u16>,
    line_starts: Vec<usize>,
}

impl SourceFile {
    pub fn parse(bytes: Vec<u8>) -> Result<Self, TsgoError> {
        if word(&bytes, 0)? >> 24 != 5 {
            return Err(TsgoError::protocol(
                "unsupported native AST protocol; expected version 5",
            ));
        }
        let nodes = word(&bytes, 40)? as usize;
        if nodes > bytes.len() || !(bytes.len() - nodes).is_multiple_of(NODE_LEN) {
            return Err(TsgoError::protocol("invalid native AST node table"));
        }
        let mut source = Self {
            strings: word(&bytes, 28)? as usize,
            string_offsets: word(&bytes, 24)? as usize,
            extended: word(&bytes, 32)? as usize,
            bytes,
            nodes,
            file_name: PathBuf::new(),
            path: String::new(),
            text: Vec::new(),
            line_starts: Vec::new(),
        };
        let root = source.node(1)?;
        if root.kind != SOURCE_FILE {
            return Err(TsgoError::protocol("native AST root is not a SourceFile"));
        }
        let data = source.extended + (root.data & LOW_DATA) as usize;
        source.text = source.units(word(&source.bytes, data)?)?;
        source.line_starts = vec![0];
        let mut position = 0;
        while position < source.text.len() {
            match source.text[position] {
                13 => {
                    if source.text.get(position + 1) == Some(&10) {
                        position += 1;
                    }
                    source.line_starts.push(position + 1);
                }
                10 | 0x2028 | 0x2029 => source.line_starts.push(position + 1),
                _ => {}
            }
            position += 1;
        }
        source.file_name = PathBuf::from(source.string(word(&source.bytes, data + 4)?)?);
        source.path = source.string(word(&source.bytes, data + 8)?)?;
        Ok(source)
    }

    pub fn node(&self, index: u32) -> Result<Node, TsgoError> {
        if index == 0 {
            return Err(TsgoError::protocol("nil native AST node"));
        }
        let at = self.nodes + index as usize * NODE_LEN;
        Ok(Node {
            index,
            kind: word(&self.bytes, at)?,
            pos: word(&self.bytes, at + 4)? as i32,
            end: word(&self.bytes, at + 8)? as i32,
            next: word(&self.bytes, at + 12)?,
            parent: word(&self.bytes, at + 16)?,
            data: word(&self.bytes, at + 20)?,
            flags: word(&self.bytes, at + 24)?,
        })
    }

    pub fn handle(&self, node: Node) -> String {
        format!("{}.{}.{}", node.index, node.kind, self.path)
    }

    fn units(&self, index: u32) -> Result<Vec<u16>, TsgoError> {
        let offsets = self.string_offsets + index as usize * 4;
        let start = self.strings + word(&self.bytes, offsets)? as usize;
        let end = self.strings + word(&self.bytes, offsets + 4)? as usize;
        decode_wtf8(
            self.bytes
                .get(start..end)
                .ok_or_else(|| TsgoError::protocol("invalid native AST string offsets"))?,
        )
    }

    fn string(&self, index: u32) -> Result<String, TsgoError> {
        String::from_utf16(&self.units(index)?).map_err(|error| {
            TsgoError::protocol(format!("native AST metadata is not Unicode: {error}"))
        })
    }

    fn text_units(&self, node: Node) -> Result<Vec<u16>, TsgoError> {
        let index = if node.kind == IDENTIFIER {
            node.data & LOW_DATA
        } else {
            word(&self.bytes, self.extended + (node.data & LOW_DATA) as usize)?
        };
        self.units(index)
    }

    fn text(&self, node: Node) -> Result<String, TsgoError> {
        String::from_utf16(&self.text_units(node)?).map_err(|error| {
            TsgoError::protocol(format!("native identifier is not Unicode: {error}"))
        })
    }

    fn child(&self, parent: Node, order: u32) -> Result<Option<Node>, TsgoError> {
        let mask = if parent.data & 0xc000_0000 == 0 {
            parent.data & 0xff
        } else {
            0xff
        };
        if mask & (1 << order) == 0 {
            return Ok(None);
        }
        let count = (mask & ((1 << order) - 1)).count_ones();
        let mut child = self.node(parent.index + 1)?;
        for _ in 0..count {
            child = self.node(child.next)?;
        }
        Ok(Some(child))
    }

    pub fn named_child(&self, parent: Node, name: &str) -> Result<Option<Node>, TsgoError> {
        let Some(order) = METADATA
            .child_properties
            .get(&parent.kind)
            .and_then(|properties| properties.iter().position(|property| property == name))
        else {
            return Ok(None);
        };
        self.child(parent, order as u32)
    }

    fn has_children(&self, parent: Node) -> Result<bool, TsgoError> {
        let next = parent.index as usize + 1;
        Ok(next < self.node_count() && self.node(next as u32)?.parent == parent.index)
    }
    fn node_count(&self) -> usize {
        (self.bytes.len() - self.nodes) / NODE_LEN
    }
    pub fn list_elements(&self, list: Node) -> Result<Vec<Node>, TsgoError> {
        if list.kind != u32::MAX {
            return Err(TsgoError::protocol(
                "native AST property is not a node list",
            ));
        }
        if list.data == 0 {
            return Ok(Vec::new());
        }
        let mut elements = Vec::new();
        let mut next = list.index + 1;
        while next != 0 {
            if elements.len() >= self.node_count() {
                return Err(TsgoError::protocol("native AST node list contains a cycle"));
            }
            let child = self.node(next)?;
            if child.kind == u32::MAX {
                return Err(TsgoError::protocol(
                    "native AST node list contains another list",
                ));
            }
            elements.push(child);
            next = child.next;
        }
        if elements.len() != list.data as usize {
            return Err(TsgoError::protocol(
                "native AST node list has the wrong length",
            ));
        }
        Ok(elements)
    }
    pub fn children(&self, parent: Node) -> Result<Vec<Node>, TsgoError> {
        if !self.has_children(parent)? {
            return Ok(Vec::new());
        }
        let mut children = Vec::new();
        let mut next = parent.index + 1;
        let mut visited = 0;
        while next != 0 {
            if visited >= self.node_count() {
                return Err(TsgoError::protocol(
                    "native AST child list contains a cycle",
                ));
            }
            visited += 1;
            let child = self.node(next)?;
            if child.kind == u32::MAX {
                children.extend(self.list_elements(child)?);
            } else if !is_kind(child.kind, "JSDoc") {
                children.push(child);
            }
            next = child.next;
        }
        Ok(children)
    }
    pub fn parent(&self, node: Node) -> Result<Option<Node>, TsgoError> {
        if node.index == 1 {
            return Ok(None);
        }
        let mut parent = node.parent;
        let mut visited = 0;
        loop {
            if parent == node.index {
                return Ok(Some(self.node(1)?));
            }
            if visited >= self.node_count() {
                return Err(TsgoError::protocol(
                    "native AST parent chain contains a cycle",
                ));
            }
            visited += 1;
            let ancestor = self.node(parent)?;
            if ancestor.kind != u32::MAX {
                return Ok(Some(ancestor));
            }
            parent = ancestor.parent;
        }
    }
    pub fn literal_units(&self, node: Node) -> Result<Option<Vec<u16>>, TsgoError> {
        let string_data = [
            "Identifier",
            "PrivateIdentifier",
            "JsxText",
            "JSDocText",
            "JSDocLink",
            "JSDocLinkPlain",
            "JSDocLinkCode",
        ]
        .iter()
        .any(|name| is_kind(node.kind, name));
        let extended_data = [
            "StringLiteral",
            "NumericLiteral",
            "BigIntLiteral",
            "RegularExpressionLiteral",
            "NoSubstitutionTemplateLiteral",
            "TemplateHead",
            "TemplateMiddle",
            "TemplateTail",
            "SourceFile",
        ]
        .iter()
        .any(|name| is_kind(node.kind, name));
        if string_data {
            self.units(node.data & LOW_DATA).map(Some)
        } else if extended_data {
            self.units(word(
                &self.bytes,
                self.extended + (node.data & LOW_DATA) as usize,
            )?)
            .map(Some)
        } else {
            Ok(None)
        }
    }
    pub fn is_declaration_file(&self) -> bool {
        self.node(1).expect("validated source root").flags & METADATA.node_flags["Ambient"] != 0
    }
    pub fn node_start(&self, node: Node) -> Result<usize, TsgoError> {
        let start = usize::try_from(node.pos).map_err(|_| {
            TsgoError::protocol("native AST node has a synthetic negative position")
        })?;
        if node.pos == node.end && !is_kind(node.kind, "EndOfFile") {
            return Ok(start);
        }
        let stop_comments = (308..=343).contains(&node.kind) || is_kind(node.kind, "JsxText");
        Ok(skip_trivia(
            &self.text,
            start,
            !stop_comments && node.flags & METADATA.node_flags["JSDoc"] != 0,
            stop_comments,
        ))
    }
    pub fn node_text(&self, node: Node) -> Result<String, TsgoError> {
        let start = self.node_start(node)?;
        let end = usize::try_from(node.end)
            .map_err(|_| TsgoError::protocol("native AST node has a synthetic negative end"))?;
        let units = self
            .text
            .get(start..end)
            .ok_or_else(|| TsgoError::protocol("native AST node has an invalid source span"))?;
        String::from_utf16(units).map_err(|error| {
            TsgoError::protocol(format!("native AST source span is not Unicode: {error}"))
        })
    }

    pub fn imported_module(&self, specifier: &str) -> Result<Option<Node>, TsgoError> {
        let expected: Vec<u16> = specifier.encode_utf16().collect();
        let Some(statements) = self.child(self.node(1)?, 0)? else {
            return Ok(None);
        };
        if statements.kind != u32::MAX {
            return Err(TsgoError::protocol(
                "SourceFile statements are not a node list",
            ));
        }
        let mut index = statements.index + 1;
        for _ in 0..statements.data {
            let statement = self.node(index)?;
            if statement.kind == IMPORT_DECLARATION
                && let Some(literal) = self.child(statement, 2)?
                && literal.kind == STRING_LITERAL
                && self.text_units(literal)? == expected
            {
                return Ok(Some(literal));
            }
            index = statement.next;
        }
        Ok(None)
    }

    pub fn declared_name(&self, declaration: Node) -> Result<Option<String>, TsgoError> {
        // Property orders come from this compiler pin's api/node/protocol.generated.js.
        let order = match declaration.kind {
            261 | 306 | 275 | 281 | 237 | 302 | 292 | 309 | 274 | 319 | 321 | 320 => Some(0),
            264 | 232 | 265 | 266 | 345 | 267 | 271 | 282 | 178 | 179 | 174 | 172 | 173 | 303
            | 304 | 203 | 296 | 268 | 272 | 277 | 169 | 333 | 340 => Some(1),
            170 | 209 | 263 | 175 | 219 | 212 | 331 | 338 => Some(2),
            _ => None,
        };
        match order
            .map(|order| self.child(declaration, order))
            .transpose()?
            .flatten()
        {
            Some(name) if name.kind == IDENTIFIER => Ok(Some(self.text(name)?)),
            _ => Ok(None),
        }
    }

    pub fn declaration_line(&self, node: Node) -> Result<usize, TsgoError> {
        let start = self.node_start(node)?;
        Ok(self
            .line_starts
            .partition_point(|line| *line <= start)
            .saturating_sub(1)
            + 1)
    }
}

fn word(bytes: &[u8], at: usize) -> Result<u32, TsgoError> {
    let word: [u8; 4] = bytes
        .get(at..at + 4)
        .ok_or_else(|| TsgoError::protocol("truncated native AST"))?
        .try_into()
        .map_err(|_| TsgoError::protocol("invalid native AST word"))?;
    Ok(u32::from_le_bytes(word))
}

fn decode_wtf8(bytes: &[u8]) -> Result<Vec<u16>, TsgoError> {
    let mut units = Vec::new();
    let mut position = 0;
    while position < bytes.len() {
        let first = bytes[position];
        let (count, mut value, minimum) = match first {
            0..=0x7f => (1, u32::from(first), 0),
            0xc2..=0xdf => (2, u32::from(first & 0x1f), 0x80),
            0xe0..=0xef => (3, u32::from(first & 0xf), 0x800),
            0xf0..=0xf4 => (4, u32::from(first & 7), 0x10000),
            _ => return Err(TsgoError::protocol("invalid native WTF-8 string")),
        };
        for offset in 1..count {
            let byte = *bytes
                .get(position + offset)
                .ok_or_else(|| TsgoError::protocol("truncated native WTF-8 string"))?;
            if byte & 0xc0 != 0x80 {
                return Err(TsgoError::protocol("invalid native WTF-8 continuation"));
            }
            value = value << 6 | u32::from(byte & 0x3f);
        }
        if value < minimum || value > 0x10ffff {
            return Err(TsgoError::protocol("invalid native WTF-8 scalar"));
        }
        if value <= 0xffff {
            units.push(value as u16);
        } else {
            units.push(0xd800 + ((value - 0x10000) >> 10) as u16);
            units.push(0xdc00 + ((value - 0x10000) & 0x3ff) as u16);
        }
        position += count;
    }
    Ok(units)
}

fn line_break(ch: u16) -> bool {
    matches!(ch, 10 | 13 | 0x2028 | 0x2029)
}

fn conflict_marker(text: &[u16], position: usize) -> bool {
    let Some(&ch) = text.get(position) else {
        return false;
    };
    (position == 0 || line_break(text[position - 1]))
        && matches!(ch, 60 | 62 | 61 | 124)
        && text
            .get(position..position + 7)
            .is_some_and(|seven| seven.iter().all(|part| *part == ch))
        && (ch == 61 || ch == 124 || text.get(position + 7) == Some(&32))
}

fn skip_trivia(text: &[u16], mut position: usize, in_jsdoc: bool, stop_comments: bool) -> usize {
    let mut consume_star = false;
    while let Some(&ch) = text.get(position) {
        match ch {
            10 | 13 => {
                if ch == 13 && text.get(position + 1) == Some(&10) {
                    position += 1;
                }
                position += 1;
                consume_star = in_jsdoc;
            }
            9
            | 11
            | 12
            | 32
            | 0x85
            | 0xa0
            | 0x1680
            | 0x2000..=0x200b
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff => position += 1,
            47 if !stop_comments && text.get(position + 1) == Some(&47) => {
                position += 2;
                while position < text.len() && !line_break(text[position]) {
                    position += 1;
                }
                consume_star = false;
            }
            47 if !stop_comments && text.get(position + 1) == Some(&42) => {
                position += 2;
                while position < text.len() {
                    if text[position] == 42 && text.get(position + 1) == Some(&47) {
                        position += 2;
                        break;
                    }
                    position += 1;
                }
                consume_star = false;
            }
            60 | 62 | 61 | 124 if conflict_marker(text, position) => {
                if ch == 60 || ch == 62 {
                    while position < text.len() && !line_break(text[position]) {
                        position += 1;
                    }
                } else {
                    position += 7;
                    while position < text.len() {
                        if matches!(text[position], 61 | 62) && conflict_marker(text, position) {
                            break;
                        }
                        position += 1;
                    }
                }
                consume_star = false;
            }
            35 if position == 0 && text.get(1) == Some(&33) => {
                while position < text.len() && !line_break(text[position]) {
                    position += 1;
                }
            }
            42 if consume_star => {
                position += 1;
                consume_star = false;
            }
            _ => break,
        }
    }
    position
}
