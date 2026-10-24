use std::cell::RefCell;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::rc::Rc;

use super::ast::{self, Node, SourceFile};
use super::{Symbol, TsgoError};
use crate::text::JsString;

#[derive(Clone)]
pub struct NativeFile {
    pub(super) source: Rc<SourceFile>,
    pub(super) owner: Rc<()>,
}
impl NativeFile {
    pub fn file_name(&self) -> &Path {
        &self.source.file_name
    }
    pub fn root(&self) -> NativeNode {
        NativeNode {
            file: self.clone(),
            node: self.source.node(1).expect("validated native source root"),
        }
    }
    pub fn is_declaration_file(&self) -> bool {
        self.source.is_declaration_file()
    }
}

#[derive(Clone)]
pub struct NativeNode {
    pub(super) file: NativeFile,
    pub(super) node: Node,
}
impl NativeNode {
    pub fn kind(&self) -> u32 {
        self.node.kind
    }
    pub fn flags(&self) -> u32 {
        self.node.flags
    }
    pub(crate) fn is_statement(&self) -> bool {
        ast::is_statement(self.node.kind)
    }
    pub(crate) fn type_only_specifier(&self) -> bool {
        self.node.data & (1 << 24) != 0
    }
    pub(crate) fn type_only_import_clause(&self) -> bool {
        (self.node.data >> 24) & 3 == 1
    }
    pub(crate) fn is_extends_clause(&self) -> bool {
        self.is_kind("HeritageClause") && (self.node.data >> 24) & 1 == 0
    }
    pub(crate) fn required_node(&self, field: &str) -> Result<Self, TsgoError> {
        self.node(field)?.ok_or_else(|| {
            TsgoError::protocol(format!(
                "native AST {} has no required {field}",
                self.kind_name().unwrap_or("node")
            ))
        })
    }
    pub fn kind_name(&self) -> Option<&'static str> {
        ast::kind_name(self.kind())
    }
    pub fn is_kind(&self, name: &str) -> bool {
        ast::is_kind(self.kind(), name)
    }
    pub fn id(&self) -> String {
        self.file.source.handle(self.node)
    }
    pub fn file_name(&self) -> &Path {
        self.file.file_name()
    }
    pub fn source_file(&self) -> NativeFile {
        self.file.clone()
    }
    pub fn start(&self) -> Result<usize, TsgoError> {
        self.file.source.node_start(self.node)
    }
    pub fn end(&self) -> Result<usize, TsgoError> {
        usize::try_from(self.node.end)
            .map_err(|_| TsgoError::protocol("native AST node has a synthetic negative end"))
    }
    pub fn start_line(&self) -> Result<usize, TsgoError> {
        self.file.source.declaration_line(self.node)
    }
    pub fn text(&self) -> Result<String, TsgoError> {
        self.file.source.node_text(self.node)
    }
    pub fn literal_text(&self) -> Result<Option<JsString>, TsgoError> {
        Ok(self
            .file
            .source
            .literal_units(self.node)?
            .map(JsString::from_units))
    }
    fn wrap(&self, node: Node) -> Self {
        Self {
            file: self.file.clone(),
            node,
        }
    }
    pub fn parent(&self) -> Result<Option<Self>, TsgoError> {
        Ok(self
            .file
            .source
            .parent(self.node)?
            .map(|node| self.wrap(node)))
    }
    pub fn children(&self) -> Result<Vec<Self>, TsgoError> {
        Ok(self
            .file
            .source
            .children(self.node)?
            .into_iter()
            .map(|node| self.wrap(node))
            .collect())
    }
    pub fn descendants(&self) -> Result<Vec<Self>, TsgoError> {
        let mut pending: Vec<_> = self.children()?.into_iter().rev().collect();
        let mut out = Vec::new();
        while let Some(node) = pending.pop() {
            pending.extend(node.children()?.into_iter().rev());
            out.push(node);
        }
        Ok(out)
    }
    pub fn node(&self, name: &str) -> Result<Option<Self>, TsgoError> {
        let Some(node) = self.file.source.named_child(self.node, name)? else {
            return Ok(None);
        };
        if node.kind == u32::MAX {
            return Err(TsgoError::protocol(format!(
                "native AST property {name} is a list"
            )));
        }
        Ok(Some(self.wrap(node)))
    }
    pub fn nodes(&self, name: &str) -> Result<Vec<Self>, TsgoError> {
        let Some(node) = self.file.source.named_child(self.node, name)? else {
            return Ok(Vec::new());
        };
        Ok(self
            .file
            .source
            .list_elements(node)?
            .into_iter()
            .map(|node| self.wrap(node))
            .collect())
    }
    pub(super) fn belongs_to(&self, owner: &Rc<()>) -> bool {
        Rc::ptr_eq(&self.file.owner, owner)
    }
}
impl PartialEq for NativeNode {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.file.owner, &other.file.owner)
            && Rc::ptr_eq(&self.file.source, &other.file.source)
            && self.node.index == other.node.index
    }
}
impl Eq for NativeNode {}
impl Hash for NativeNode {
    fn hash<H: Hasher>(&self, state: &mut H) {
        Rc::as_ptr(&self.file.owner).hash(state);
        Rc::as_ptr(&self.file.source).hash(state);
        self.node.index.hash(state);
    }
}
impl std::fmt::Debug for NativeNode {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.id())
    }
}

#[derive(Clone)]
pub struct NativeSymbol {
    pub(super) owner: Rc<()>,
    pub(super) data: Rc<RefCell<Symbol>>,
}
impl NativeSymbol {
    pub fn name(&self) -> String {
        self.data.borrow().display_name().to_owned()
    }
    pub fn flags(&self) -> u32 {
        self.data.borrow().flags
    }
}
impl PartialEq for NativeSymbol {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.owner, &other.owner) && self.data.borrow().id == other.data.borrow().id
    }
}
impl Eq for NativeSymbol {}
impl Hash for NativeSymbol {
    fn hash<H: Hasher>(&self, state: &mut H) {
        Rc::as_ptr(&self.owner).hash(state);
        self.data.borrow().id.hash(state);
    }
}
