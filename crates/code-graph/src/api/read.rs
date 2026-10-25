use super::{
    model::{ApiEntryText, ApiReferences, SubpathNames},
    text::{declaration_text, statement_of},
};
use crate::{
    engine::tsgo::{NativeNode, TsgoError, TypeProgram},
    project::relative_path_text_from,
    text::JsString,
};
use indexmap::IndexMap;
use std::{
    collections::{HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::Arc,
};

type NodeKey = (PathBuf, i32, usize, u32);
fn node_key(node: &NativeNode) -> Result<NodeKey, TsgoError> {
    Ok((
        node.file_name().to_path_buf(),
        node.pos(),
        node.end()?,
        node.kind(),
    ))
}
fn by_file_position(left: &NativeNode, right: &NativeNode) -> std::cmp::Ordering {
    left.file_name()
        .to_string_lossy()
        .encode_utf16()
        .cmp(right.file_name().to_string_lossy().encode_utf16())
        .then(left.pos().cmp(&right.pos()))
}
fn statements_of(declarations: Vec<NativeNode>) -> Result<Vec<NativeNode>, TsgoError> {
    let mut statements = IndexMap::new();
    for declaration in declarations {
        let statement = statement_of(&declaration)?;
        statements.insert(node_key(&statement)?, statement);
    }
    let mut statements = statements.into_values().collect::<Vec<_>>();
    statements.sort_by(by_file_position);
    Ok(statements)
}
fn joined_text(statements: &[NativeNode]) -> Result<JsString, TsgoError> {
    Ok(crate::render::text::join(
        statements
            .iter()
            .map(declaration_text)
            .collect::<Result<Vec<_>, _>>()?,
        "\n",
    ))
}
fn entity_name(name: Option<NativeNode>) -> Result<Option<NativeNode>, TsgoError> {
    match name {
        Some(name) if name.is_kind("QualifiedName") => name.node("right"),
        name => Ok(name),
    }
}
fn expression_name(node: Option<NativeNode>) -> Result<Option<NativeNode>, TsgoError> {
    match node {
        Some(node) if node.is_kind("PropertyAccessExpression") => node.node("name"),
        node => Ok(node),
    }
}
fn reference_name(node: &NativeNode) -> Result<Option<NativeNode>, TsgoError> {
    // Reverse SyntaxKind labels include aliases (ImportType is LastTypeNode).
    // Semantic predicates compare the pinned kind values, as the source does.
    if node.is_kind("TypeReference") {
        return entity_name(node.node("typeName")?);
    }
    if node.is_kind("TypeQuery") {
        return entity_name(node.node("exprName")?);
    }
    if node.is_kind("ImportType") {
        return entity_name(node.node("qualifier")?);
    }
    if node.is_kind("ExpressionWithTypeArguments") || node.is_kind("ComputedPropertyName") {
        return expression_name(node.node("expression")?);
    }
    Ok(None)
}

fn reference_names(statement: &NativeNode) -> Result<Vec<NativeNode>, TsgoError> {
    let mut names = Vec::new();
    let mut pending = vec![statement.clone()];
    while let Some(node) = pending.pop() {
        if let Some(name) = reference_name(&node)? {
            names.push(name);
        }
        pending.extend(node.children()?.into_iter().rev());
    }
    Ok(names)
}
fn top_level_declaration(node: &NativeNode) -> bool {
    [
        "TypeAliasDeclaration",
        "InterfaceDeclaration",
        "ClassDeclaration",
        "EnumDeclaration",
        "FunctionDeclaration",
        "ModuleDeclaration",
        "VariableDeclaration",
    ]
    .into_iter()
    .any(|kind| node.is_kind(kind))
}

fn declared_name(node: &NativeNode) -> Result<JsString, TsgoError> {
    match node.node("name")? {
        Some(name) if name.is_kind("Identifier") => Ok(name.literal_text()?.unwrap_or_default()),
        _ => Ok("default".into()),
    }
}
struct ReferenceWalk<'a, 'p> {
    program: &'a mut TypeProgram<'p>,
    out: &'a JsString,
    published: &'a HashSet<NodeKey>,
    references: IndexMap<JsString, IndexMap<NodeKey, NativeNode>>,
    walked: HashSet<NodeKey>,
}
impl ReferenceWalk<'_, '_> {
    fn unpublished(&self, declaration: &NativeNode) -> Result<Option<NativeNode>, TsgoError> {
        if !top_level_declaration(declaration) {
            return Ok(None);
        }
        let mut prefix = self.out.clone();
        prefix.push_str(std::path::MAIN_SEPARATOR_STR);
        let file = JsString::from(declaration.file_name().to_string_lossy().as_ref());
        if !file.units().starts_with(prefix.units()) {
            return Ok(None);
        }
        let statement = statement_of(declaration)?;
        let Some(holder) = statement.parent()? else {
            return Ok(None);
        };
        if !holder.is_kind("SourceFile") && !holder.is_kind("ModuleBlock") {
            return Ok(None);
        }
        let mut at = Some(statement.clone());
        while let Some(node) = at {
            if self.published.contains(&node_key(&node)?) {
                return Ok(None);
            }
            if node.is_kind("SourceFile") {
                break;
            }
            at = node.parent()?;
        }
        Ok(Some(statement))
    }
    fn record(
        &mut self,
        declaration: &NativeNode,
        statement: NativeNode,
    ) -> Result<Option<NativeNode>, TsgoError> {
        let file = JsString::from(declaration.file_name().to_string_lossy().as_ref());
        let mut key = relative_path_text_from(self.out, &file).map_err(TsgoError::Io)?;
        if cfg!(windows) {
            key = key.to_lossy().replace('\\', "/").into();
        }
        key.push_str("#");
        key.extend(&declared_name(declaration)?);
        let node_key = node_key(&statement)?;
        self.references
            .entry(key)
            .or_default()
            .insert(node_key.clone(), statement.clone());
        Ok(self.walked.insert(node_key).then_some(statement))
    }
    fn from(mut self, statements: &[NativeNode]) -> Result<ApiReferences, TsgoError> {
        let mut queue = VecDeque::from(statements.to_vec());
        for statement in statements {
            self.walked.insert(node_key(statement)?);
        }
        while let Some(statement) = queue.pop_front() {
            let names = reference_names(&statement)?;
            for symbol in self.program.symbols_at(&names)?.into_iter().flatten() {
                let target = self.program.alias_target(&symbol)?.unwrap_or(symbol);
                for declaration in self.program.declarations(&target)? {
                    if let Some(statement) = self.unpublished(&declaration)?
                        && let Some(reached) = self.record(&declaration, statement)?
                    {
                        queue.push_back(reached);
                    }
                }
            }
        }
        self.references
            .into_iter()
            .map(|(key, statements)| {
                let mut statements = statements.into_values().collect::<Vec<_>>();
                statements.sort_by(by_file_position);
                Ok((key, joined_text(&statements)?))
            })
            .collect()
    }
}

pub fn read_subpath_names(
    program: &mut TypeProgram<'_>,
    out: &JsString,
    entry_file: &Path,
) -> Result<SubpathNames, TsgoError> {
    let Some(module) = program.module_symbol_of(entry_file)? else {
        return Ok(SubpathNames::default());
    };
    let mut names = Vec::new();
    for (name, symbol) in program.exports_of(&module)? {
        let symbol = program.alias_target(&symbol)?.unwrap_or(symbol);
        names.push((
            JsString::from(name),
            statements_of(program.declarations(&symbol)?)?,
        ));
    }
    let mut published = HashSet::new();
    for (_, statements) in &names {
        for statement in statements {
            published.insert(node_key(statement)?);
        }
    }
    let mut read = SubpathNames::default();
    for (name, declarations) in names {
        let references = ReferenceWalk {
            program,
            out,
            published: &published,
            references: IndexMap::new(),
            walked: HashSet::new(),
        }
        .from(&declarations)?;
        read.assign(
            name,
            Arc::new(ApiEntryText {
                text: joined_text(&declarations)?,
                references: Arc::new(references),
            }),
        );
    }
    Ok(read)
}
