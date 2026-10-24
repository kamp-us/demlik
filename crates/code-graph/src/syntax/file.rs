use std::borrow::Cow;
use std::cell::OnceCell;
use std::collections::HashMap;
use std::fmt;
use std::rc::Rc;
use std::sync::LazyLock;

use super::trivia::Trivia;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VisitorData {
    parser_version: String,
    visitor_keys: HashMap<String, Vec<String>>,
}

static VISITOR_DATA: LazyLock<VisitorData> = LazyLock::new(|| {
    let data: VisitorData = serde_json::from_str(include_str!("visitor_keys_0_151.json"))
        .expect("checked-in OXC visitor metadata is valid JSON");
    assert_eq!(data.parser_version, "0.151.0");
    data
});

#[derive(Debug, Clone, Serialize)]
pub struct Comment {
    pub start: usize,
    pub end: usize,
    #[serde(rename = "type")]
    pub kind: String,
    pub value: String,
}

#[derive(Debug)]
enum Field {
    Scalar(Value),
    Utf16(Vec<u16>),
    Node(usize),
    Array(Vec<Field>),
    Object(IndexMap<String, Field>),
}

pub(crate) struct Utf16Field {
    pub kind: &'static str,
    pub start: usize,
    pub end: usize,
    pub path: &'static [&'static str],
    pub units: Vec<u16>,
}

#[derive(Debug)]
struct Node {
    kind: String,
    start: usize,
    end: usize,
    parent: Option<usize>,
    fields: IndexMap<String, Field>,
    children: Vec<usize>,
}

#[derive(Debug)]
pub struct SyntaxFile {
    text: String,
    units: Rc<[u16]>,
    line_starts: Vec<usize>,
    comments: Vec<Comment>,
    nodes: Vec<Node>,
    trivia: OnceCell<Trivia>,
}

impl SyntaxFile {
    pub(crate) fn from_estree(
        text: String,
        tree: Value,
        comments: Vec<Comment>,
        strings: Vec<Utf16Field>,
    ) -> Self {
        let units: Vec<u16> = text.encode_utf16().collect();
        let mut line_starts = vec![0];
        let mut position = 0;
        while position < units.len() {
            match units[position] {
                13 => {
                    if units.get(position + 1) == Some(&10) {
                        position += 1;
                    }
                    line_starts.push(position + 1);
                }
                10 | 0x2028 | 0x2029 => line_starts.push(position + 1),
                _ => {}
            }
            position += 1;
        }
        let mut nodes = Vec::new();
        assert!(
            matches!(flatten(tree, &mut nodes), Field::Node(0)),
            "OXC emits a root node"
        );
        for string in strings {
            let node = nodes
                .iter_mut()
                .find(|node| {
                    node.kind == string.kind && node.start == string.start && node.end == string.end
                })
                .expect("OXC serializes each visited string node");
            let mut field = node
                .fields
                .get_mut(string.path[0])
                .expect("OXC string field exists");
            for key in &string.path[1..] {
                field = match field {
                    Field::Object(fields) => fields.get_mut(*key).expect("OXC string field exists"),
                    _ => unreachable!("OXC string path contains only objects"),
                };
            }
            *field = Field::Utf16(string.units);
        }
        for index in 0..nodes.len() {
            let mut children = Vec::new();
            for key in VISITOR_DATA
                .visitor_keys
                .get(&nodes[index].kind)
                .into_iter()
                .flatten()
            {
                match nodes[index].fields.get(key) {
                    Some(Field::Node(child)) => children.push(*child),
                    Some(Field::Array(items)) => children.extend(items.iter().filter_map(|item| {
                        if let Field::Node(child) = item {
                            Some(*child)
                        } else {
                            None
                        }
                    })),
                    _ => {}
                }
            }
            children.sort_by_key(|child| nodes[*child].start);
            nodes[index].children = children;
        }
        let mut pending = vec![0];
        while let Some(index) = pending.pop() {
            for child in nodes[index].children.clone() {
                nodes[child].parent = Some(index);
                pending.push(child);
            }
        }
        Self {
            text,
            units: units.into(),
            line_starts,
            comments,
            nodes,
            trivia: OnceCell::new(),
        }
    }

    pub fn root(&self) -> NodeRef<'_> {
        NodeRef {
            file: self,
            index: 0,
        }
    }
    pub(crate) fn node_at(&self, index: usize) -> NodeRef<'_> {
        NodeRef { file: self, index }
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn text_units(&self) -> &[u16] {
        &self.units
    }
    pub fn comments(&self) -> &[Comment] {
        &self.comments
    }
    pub fn trivia(&self) -> &Trivia {
        self.trivia
            .get_or_init(|| Trivia::new(self.units.clone(), &self.comments))
    }
    pub fn comment_start_ending_at(&self, position: usize) -> Option<usize> {
        self.trivia().comment_start_ending_at(position)
    }
    pub fn line_of(&self, position: usize) -> usize {
        self.line_starts
            .partition_point(|start| *start <= position)
            .saturating_sub(1)
            + 1
    }
    pub fn line_count(&self) -> usize {
        self.line_of(self.units.len())
    }
    pub fn slice(&self, start: usize, end: usize) -> String {
        String::from_utf16_lossy(
            &self.units[start.min(self.units.len())
                ..end.min(self.units.len()).max(start.min(self.units.len()))],
        )
    }
}

#[derive(Clone, Copy)]
pub struct NodeRef<'a> {
    file: &'a SyntaxFile,
    index: usize,
}

impl fmt::Debug for NodeRef<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}@{}..{}",
            self.kind(),
            self.start(),
            self.end()
        )
    }
}

impl PartialEq for NodeRef<'_> {
    fn eq(&self, other: &Self) -> bool {
        std::ptr::eq(self.file, other.file) && self.index == other.index
    }
}
impl Eq for NodeRef<'_> {}

impl<'a> NodeRef<'a> {
    fn data(self) -> &'a Node {
        &self.file.nodes[self.index]
    }
    pub fn syntax(self) -> &'a SyntaxFile {
        self.file
    }
    pub(crate) fn index(self) -> usize {
        self.index
    }
    pub fn kind(self) -> &'a str {
        &self.data().kind
    }
    pub fn start(self) -> usize {
        self.data().start
    }
    pub fn end(self) -> usize {
        self.data().end
    }
    pub fn parent(self) -> Option<Self> {
        self.data().parent.map(|index| Self {
            file: self.file,
            index,
        })
    }
    pub fn children(self) -> Vec<Self> {
        self.data()
            .children
            .iter()
            .map(|index| Self {
                file: self.file,
                index: *index,
            })
            .collect()
    }
    pub fn node(self, key: &str) -> Option<Self> {
        match self.data().fields.get(key) {
            Some(Field::Node(index)) => Some(Self {
                file: self.file,
                index: *index,
            }),
            _ => None,
        }
    }
    pub fn nodes(self, key: &str) -> Vec<Self> {
        match self.data().fields.get(key) {
            Some(Field::Array(items)) => items
                .iter()
                .filter_map(|item| {
                    if let Field::Node(index) = item {
                        Some(Self {
                            file: self.file,
                            index: *index,
                        })
                    } else {
                        None
                    }
                })
                .collect(),
            _ => Vec::new(),
        }
    }
    pub fn string(self, key: &str) -> Option<&'a str> {
        self.string_path(&[key])
    }
    fn field_path(self, keys: &[&str]) -> Option<&'a Field> {
        let mut found = self.data().fields.get(*keys.first()?)?;
        for key in &keys[1..] {
            found = match found {
                Field::Object(fields) => fields.get(*key)?,
                _ => return None,
            };
        }
        Some(found)
    }
    pub fn string_path(self, keys: &[&str]) -> Option<&'a str> {
        match self.field_path(keys)? {
            Field::Scalar(Value::String(value)) => Some(value),
            _ => None,
        }
    }
    /// JavaScript string values can include lone UTF-16 surrogates.
    pub fn string_units(self, key: &str) -> Option<Cow<'a, [u16]>> {
        self.string_units_path(&[key])
    }
    pub fn string_units_path(self, keys: &[&str]) -> Option<Cow<'a, [u16]>> {
        match self.field_path(keys)? {
            Field::Scalar(Value::String(value)) => Some(Cow::Owned(value.encode_utf16().collect())),
            Field::Utf16(units) => Some(Cow::Borrowed(units)),
            _ => None,
        }
    }
    pub fn boolean(self, key: &str) -> Option<bool> {
        match self.data().fields.get(key) {
            Some(Field::Scalar(Value::Bool(value))) => Some(*value),
            _ => None,
        }
    }
    pub fn text(self) -> String {
        self.file.slice(self.start(), self.end())
    }
    pub fn ts_start(self) -> usize {
        if let Some(parent) = self.parent()
            && matches!(
                parent.kind(),
                "ExportNamedDeclaration" | "ExportDefaultDeclaration"
            )
            && parent.node("declaration") == Some(self)
            && matches!(
                self.kind(),
                "FunctionDeclaration"
                    | "TSDeclareFunction"
                    | "ClassDeclaration"
                    | "VariableDeclaration"
                    | "TSInterfaceDeclaration"
                    | "TSTypeAliasDeclaration"
                    | "TSEnumDeclaration"
                    | "TSModuleDeclaration"
                    | "TSImportEqualsDeclaration"
            )
        {
            parent.start()
        } else {
            self.start()
        }
    }
    pub fn start_line(self) -> usize {
        self.file.line_of(self.ts_start())
    }
    pub fn start_column(self) -> usize {
        let start = self.ts_start();
        start - self.file.line_starts[self.file.line_of(start) - 1] + 1
    }
    pub fn end_line(self) -> usize {
        self.file.line_of(self.end())
    }
    pub fn ts_children(self) -> Vec<Self> {
        self.children()
            .into_iter()
            .flat_map(|child| {
                if is_method_value(child) {
                    child.children()
                } else {
                    vec![child]
                }
            })
            .collect()
    }
    pub fn ts_descendants(self) -> Vec<Self> {
        let mut pending: Vec<_> = self.ts_children().into_iter().rev().collect();
        let mut out = Vec::new();
        while let Some(node) = pending.pop() {
            out.push(node);
            pending.extend(node.ts_children().into_iter().rev());
        }
        out
    }
}

pub fn is_accessor_kind(node: NodeRef<'_>) -> bool {
    matches!(node.string("kind"), Some("get" | "set"))
}

pub fn is_method_value(node: NodeRef<'_>) -> bool {
    if !matches!(
        node.kind(),
        "FunctionExpression" | "TSEmptyBodyFunctionExpression"
    ) {
        return false;
    }
    node.parent().is_some_and(|parent| {
        matches!(
            parent.kind(),
            "MethodDefinition" | "TSAbstractMethodDefinition"
        ) || (parent.kind() == "Property"
            && (parent.boolean("method") == Some(true) || is_accessor_kind(parent)))
    })
}

fn flatten(value: Value, nodes: &mut Vec<Node>) -> Field {
    match value {
        Value::Object(mut fields) if fields.get("type").is_some_and(Value::is_string) => {
            let kind = fields
                .remove("type")
                .and_then(|value| value.as_str().map(str::to_owned))
                .expect("node type is a string");
            let start = fields
                .remove("start")
                .and_then(|value| value.as_u64())
                .expect("OXC node start is an offset") as usize;
            let end = fields
                .remove("end")
                .and_then(|value| value.as_u64())
                .expect("OXC node end is an offset") as usize;
            let index = nodes.len();
            nodes.push(Node {
                kind,
                start,
                end,
                parent: None,
                fields: IndexMap::new(),
                children: Vec::new(),
            });
            let fields = fields
                .into_iter()
                .map(|(key, value)| (key, flatten(value, nodes)))
                .collect();
            nodes[index].fields = fields;
            Field::Node(index)
        }
        Value::Object(fields) => Field::Object(
            fields
                .into_iter()
                .map(|(key, value)| (key, flatten(value, nodes)))
                .collect(),
        ),
        Value::Array(items) => Field::Array(
            items
                .into_iter()
                .map(|value| flatten(value, nodes))
                .collect(),
        ),
        value => Field::Scalar(value),
    }
}
