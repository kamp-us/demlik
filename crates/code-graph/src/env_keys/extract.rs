use crate::{
    extract::functions::name_text,
    project::{Collation, CollationError, CollationInput, SourceUnit},
    syntax::file::NodeRef,
    text::{JsRegex, JsString},
};
use indexmap::{IndexMap, IndexSet};
use std::rc::Rc;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum EnvReadVia {
    Env,
    ProcessEnv,
}
impl EnvReadVia {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Env => "env",
            Self::ProcessEnv => "process-env",
        }
    }
}
#[derive(Debug)]
pub(super) struct EnvRead {
    pub name: JsString,
    pub file: JsString,
    pub line: usize,
    pub via: EnvReadVia,
}
pub(super) struct EnvKeyScan {
    pub reads: Vec<EnvRead>,
    pub occurs_in: IndexMap<JsString, Vec<JsString>>,
}
fn receiver_via(node: NodeRef<'_>) -> Option<EnvReadVia> {
    let text = node.text();
    if text == "process.env" || text.ends_with(".process.env") {
        Some(EnvReadVia::ProcessEnv)
    } else if text == "env" || text.ends_with(".env") {
        Some(EnvReadVia::Env)
    } else {
        None
    }
}
fn string_field(node: NodeRef<'_>, field: &str) -> Option<JsString> {
    node.string_units(field)
        .map(|s| JsString::from_units(s.into_owned()))
}
fn occurrence_name(node: NodeRef<'_>, candidates: &IndexSet<JsString>) -> Option<JsString> {
    let value = match node.kind() {
        "Identifier" | "JSXIdentifier" => string_field(node, "name"),
        "PrivateIdentifier" => string_field(node, "name").map(|name| {
            let mut value = JsString::from("#");
            value.extend(&name);
            value
        }),
        "Literal" => string_field(node, "value"),
        _ => None,
    }?;
    candidates.contains(&value).then_some(value)
}
fn member_read(node: NodeRef<'_>) -> Option<(JsString, usize, EnvReadVia)> {
    if node.kind() != "MemberExpression" {
        return None;
    }
    let object = node.node("object")?;
    let property = node.node("property")?;
    let name = if node.boolean("computed") == Some(true) {
        if property.kind() != "Literal" {
            return None;
        }
        string_field(property, "value")?
    } else if property.kind() == "Identifier" {
        string_field(property, "name").unwrap_or_else(|| "undefined".into())
    } else {
        property.text().into()
    };
    Some((name, node.start_line(), receiver_via(object)?))
}
fn identifier_text(node: NodeRef<'_>) -> JsString {
    if node.kind() == "Identifier" {
        string_field(node, "name").unwrap_or_else(|| "undefined".into())
    } else {
        node.text().into()
    }
}
fn binding_element_names(pattern: NodeRef<'_>) -> Vec<JsString> {
    if pattern.kind() != "ObjectPattern" {
        return Vec::new();
    }
    pattern
        .nodes("properties")
        .into_iter()
        .filter_map(|element| {
            if element.kind() == "RestElement" {
                return element.node("argument").map(identifier_text);
            }
            let key = element.node("key")?;
            Some(if element.boolean("shorthand") == Some(true) {
                identifier_text(key)
            } else {
                name_text(element, key).into()
            })
        })
        .collect()
}
fn reads_at(node: NodeRef<'_>, env_type: &JsRegex) -> Vec<(JsString, usize, EnvReadVia)> {
    let mut reads = Vec::new();
    if let Some(read) = member_read(node) {
        reads.push(read);
    }
    if node.kind() == "VariableDeclarator"
        && let Some(via) = node.node("init").and_then(receiver_via)
        && let Some(pattern) = node.node("id")
    {
        reads.extend(
            binding_element_names(pattern)
                .into_iter()
                .map(|name| (name, node.start_line(), via)),
        );
    }
    for param in node.nodes("params") {
        let pattern = match param.kind() {
            "ObjectPattern" => Some(param),
            "AssignmentPattern" => param
                .node("left")
                .filter(|left| left.kind() == "ObjectPattern"),
            _ => None,
        };
        let Some(pattern) = pattern else { continue };
        let Some(annotation) = pattern
            .node("typeAnnotation")
            .and_then(|a| a.node("typeAnnotation"))
        else {
            continue;
        };
        if env_type.test_str(&annotation.text()) {
            reads.extend(
                binding_element_names(pattern)
                    .into_iter()
                    .map(|name| (name, param.start_line(), EnvReadVia::Env)),
            );
        }
    }
    reads
}
pub(super) fn scan_env_keys<'c>(
    source_files: &[Rc<SourceUnit>],
    candidates: &IndexSet<JsString>,
    request: &mut impl FnMut() -> Result<&'c Collation, CollationError>,
) -> Result<EnvKeyScan, CollationError> {
    let env_type = JsRegex::new(&JsString::from(r"\bEnv\b")).expect("fixed source regex");
    let mut reads: IndexMap<JsString, EnvRead> = IndexMap::new();
    let mut occurs: IndexMap<JsString, IndexSet<JsString>> = IndexMap::new();
    for unit in source_files {
        let file = JsString::from(unit.file.as_str());
        let mut pending = unit.syntax.root().children();
        pending.reverse();
        while let Some(node) = pending.pop() {
            for (name, line, via) in reads_at(node, &env_type) {
                let mut key = name.clone();
                key.push_str("\t");
                key.extend(&file);
                key.push_str(&format!("\t{line}\t{}", via.as_str()));
                reads.entry(key).or_insert_with(|| EnvRead {
                    name,
                    file: file.clone(),
                    line,
                    via,
                });
            }
            if let Some(name) = occurrence_name(node, candidates) {
                occurs.entry(name).or_default().insert(file.clone());
            }
            let mut children = node.children();
            children.reverse();
            pending.extend(children);
        }
    }
    let mut reads: Vec<_> = reads.into_values().collect();
    if reads.len() > 1 {
        let collation = request()?;
        let mut keyed = reads
            .into_iter()
            .map(|read| {
                let name = CollationInput::from_utf16(read.name.units())?;
                let file = CollationInput::from_utf16(read.file.units())?;
                Ok((read, name, file))
            })
            .collect::<Result<Vec<_>, CollationError>>()?;
        keyed.sort_by(|(a, an, af), (b, bn, bf)| {
            collation
                .compare(an, bn)
                .then_with(|| collation.compare(af, bf))
                .then_with(|| a.line.cmp(&b.line))
                .then_with(|| a.via.as_str().cmp(b.via.as_str()))
        });
        reads = keyed.into_iter().map(|(read, _, _)| read).collect();
    }
    let mut occurs: Vec<_> = occurs.into_iter().collect();
    if occurs.len() > 1 {
        let collation = request()?;
        let mut keyed = occurs
            .into_iter()
            .map(|(name, files)| {
                CollationInput::from_utf16(name.units()).map(|key| (name, files, key))
            })
            .collect::<Result<Vec<_>, _>>()?;
        keyed.sort_by(|(_, _, a), (_, _, b)| collation.compare(a, b));
        occurs = keyed
            .into_iter()
            .map(|(name, files, _)| (name, files))
            .collect();
    }
    let mut occurs_in = IndexMap::new();
    for (name, files) in occurs {
        let mut files: Vec<_> = files.into_iter().collect();
        if files.len() > 1 {
            let collation = request()?;
            let mut keyed = files
                .into_iter()
                .map(|file| CollationInput::from_utf16(file.units()).map(|key| (file, key)))
                .collect::<Result<Vec<_>, _>>()?;
            keyed.sort_by(|(_, a), (_, b)| collation.compare(a, b));
            files = keyed.into_iter().map(|(file, _)| file).collect();
        }
        occurs_in.insert(name, files);
    }
    Ok(EnvKeyScan { reads, occurs_in })
}
