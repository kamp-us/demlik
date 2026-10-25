use crate::{
    extract::functions::name_text,
    syntax::{SyntaxFile, file::NodeRef},
    text::JsString,
};
use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct HexagonMember {
    pub name: JsString,
    #[serde(rename = "type")]
    pub type_text: JsString,
    pub signature: Option<JsString>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct HexagonBag {
    pub name: JsString,
    pub members: Vec<HexagonMember>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct HexagonPort {
    pub name: JsString,
    #[serde(rename = "type")]
    pub type_text: JsString,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct NotRead {
    pub file: JsString,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub line: f64,
    pub name: JsString,
    pub reason: JsString,
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ports {
    pub bags: Vec<HexagonBag>,
    pub unbagged_ports: Vec<HexagonPort>,
}

const SHAPES: &[(&str, &str)] = &[
    ("TSMappedType", "mapped type"),
    ("TSConditionalType", "conditional type"),
    ("TSIntersectionType", "intersection type"),
    ("TSUnionType", "union type"),
    ("TSParenthesizedType", "parenthesized type"),
    ("TSTypeReference", "bag alias"),
    ("TSIndexSignature", "index signature"),
    ("TSCallSignatureDeclaration", "call signature"),
    ("TSConstructSignatureDeclaration", "construct signature"),
    ("TSMethodSignature", "method or accessor"),
    ("TSModuleDeclaration", "namespace declaration"),
];
fn shape(kind: &str) -> Option<&'static str> {
    SHAPES
        .iter()
        .find(|(tag, _)| *tag == kind)
        .map(|(_, reason)| *reason)
}
fn declared_name(node: Option<NodeRef<'_>>, fallback: JsString) -> JsString {
    node.and_then(|node| node.node("id").map(|id| name_text(node, id).into()))
        .unwrap_or(fallback)
}
struct ExportEntry<'a> {
    node: NodeRef<'a>,
    name: JsString,
    reason: Option<&'static str>,
}
fn export_entries(syntax: &SyntaxFile) -> Vec<ExportEntry<'_>> {
    let mut entries = Vec::new();
    for statement in syntax.root().nodes("body") {
        let declaration = statement.node("declaration");
        match statement.kind() {
            "ExportDefaultDeclaration" => entries.push(ExportEntry {
                node: statement,
                name: declared_name(declaration, "default".into()),
                reason: Some("default export"),
            }),
            "ExportAllDeclaration" => entries.push(ExportEntry {
                node: statement,
                name: statement
                    .node("exported")
                    .map_or_else(|| "*".into(), |name| name.text().into()),
                reason: Some("re-export"),
            }),
            "ExportNamedDeclaration" => {
                if let Some(node) = declaration {
                    if node.kind() == "VariableDeclaration" {
                        for binding in node.nodes("declarations") {
                            entries.push(ExportEntry {
                                node: binding,
                                name: name_text(
                                    binding,
                                    binding.node("id").expect("OXC binding has id"),
                                )
                                .into(),
                                reason: Some("value declaration"),
                            });
                        }
                    } else {
                        entries.push(ExportEntry {
                            node,
                            name: declared_name(Some(node), node.text().into()),
                            reason: None,
                        });
                    }
                } else {
                    for specifier in statement.nodes("specifiers") {
                        entries.push(ExportEntry {
                            node: specifier,
                            name: specifier
                                .node("exported")
                                .expect("OXC export has name")
                                .text()
                                .into(),
                            reason: Some(if statement.node("source").is_none() {
                                "export list"
                            } else {
                                "re-export"
                            }),
                        });
                    }
                }
            }
            "TSModuleDeclaration" => entries.push(ExportEntry {
                node: statement,
                name: statement
                    .node("id")
                    .expect("OXC module has id")
                    .text()
                    .into(),
                reason: Some("module declaration"),
            }),
            "TSExportAssignment" | "TSNamespaceExportDeclaration" => {
                let field = if statement.kind() == "TSExportAssignment" {
                    "expression"
                } else {
                    "id"
                };
                if let Some(name) = statement.node(field) {
                    entries.push(ExportEntry {
                        node: statement,
                        name: name.text().into(),
                        reason: Some("unsupported export"),
                    });
                }
            }
            _ => {}
        }
    }
    entries
}
fn plain_members(node: NodeRef<'_>) -> Option<Vec<NodeRef<'_>>> {
    match node.kind() {
        "TSInterfaceDeclaration" => Some(
            node.node("body")
                .expect("OXC interface has body")
                .nodes("body"),
        ),
        "TSTypeLiteral" => Some(node.nodes("members")),
        _ => None,
    }
}
fn member_reason(member: NodeRef<'_>) -> Option<&'static str> {
    if member.kind() != "TSPropertySignature" {
        return Some(shape(member.kind()).unwrap_or("non-property member"));
    }
    if member.boolean("computed") == Some(true) {
        return Some("computed property");
    }
    member
        .node("typeAnnotation")
        .is_none()
        .then_some("property without type")
}
fn is_port(node: NodeRef<'_>) -> bool {
    if node.kind() != "TSTypeAliasDeclaration" {
        return false;
    }
    let name = node
        .node("id")
        .and_then(|id| id.string("name"))
        .unwrap_or("");
    name.starts_with("For")
        && name.as_bytes().get(3).is_some_and(u8::is_ascii_uppercase)
        && node
            .node("typeAnnotation")
            .is_some_and(|body| matches!(body.kind(), "TSFunctionType" | "TSTypeReference"))
}
fn declaration_reason(node: NodeRef<'_>) -> Option<&'static str> {
    if is_port(node) {
        return node
            .node("typeParameters")
            .is_some()
            .then_some("generic port");
    }
    if !matches!(
        node.kind(),
        "TSTypeAliasDeclaration" | "TSInterfaceDeclaration"
    ) {
        return Some(shape(node.kind()).unwrap_or("not a port or bag declaration"));
    }
    if node.node("typeParameters").is_some() {
        return Some("generic bag");
    }
    if node.kind() == "TSInterfaceDeclaration" && !node.nodes("extends").is_empty() {
        return Some("interface extends");
    }
    let body = if node.kind() == "TSTypeAliasDeclaration" {
        node.node("typeAnnotation").expect("OXC alias has body")
    } else {
        node
    };
    let Some(members) = plain_members(body) else {
        return Some(shape(body.kind()).unwrap_or("not a port or plain bag"));
    };
    if let Some(reason) = members.iter().copied().find_map(member_reason) {
        return Some(reason);
    }
    let mut names = IndexSet::new();
    for member in members {
        let name = member
            .node("key")
            .map_or_else(String::new, |key| name_text(member, key));
        if !names.insert(name) {
            return Some("duplicate member");
        }
    }
    None
}
fn read_members(nodes: Vec<NodeRef<'_>>) -> Vec<HexagonMember> {
    let mut members: Vec<_> = nodes
        .into_iter()
        .filter_map(|member| {
            if member.kind() != "TSPropertySignature" {
                return None;
            }
            let annotation = member.node("typeAnnotation")?;
            let mut name = JsString::from(name_text(
                member,
                member.node("key").expect("OXC property has key"),
            ));
            if member.boolean("optional") == Some(true) {
                name.push_str("?");
            }
            Some(HexagonMember {
                name,
                type_text: annotation
                    .node("typeAnnotation")
                    .expect("OXC annotation has type")
                    .text()
                    .into(),
                signature: None,
            })
        })
        .collect();
    members.sort_by(|a, b| a.name.cmp(&b.name));
    members
}
pub fn read_ports(syntax: Option<&SyntaxFile>, not_read: &mut Vec<NotRead>) -> Ports {
    let Some(syntax) = syntax else {
        return Ports::default();
    };
    let mut counts: IndexMap<JsString, usize> = IndexMap::new();
    for statement in syntax.root().nodes("body") {
        let node = statement.node("declaration").unwrap_or(statement);
        if let Some(id) = node.node("id") {
            *counts.entry(name_text(node, id).into()).or_default() += 1;
        }
    }
    let mut bags = Vec::new();
    let mut ports = Vec::new();
    for entry in export_entries(syntax) {
        let reason = entry.reason.or_else(|| {
            if counts.get(&entry.name).copied().unwrap_or(0) > 1 {
                Some("multiple declarations")
            } else {
                declaration_reason(entry.node)
            }
        });
        if let Some(reason) = reason {
            not_read.push(NotRead {
                file: "ports.ts".into(),
                line: entry.node.start_line() as f64,
                name: entry.name,
                reason: reason.into(),
            });
            continue;
        }
        let body = if entry.node.kind() == "TSTypeAliasDeclaration" {
            entry
                .node
                .node("typeAnnotation")
                .expect("OXC alias has body")
        } else {
            entry.node
        };
        if let Some(members) = plain_members(body) {
            bags.push(HexagonBag {
                name: entry.name,
                members: read_members(members),
            });
        } else {
            ports.push(HexagonPort {
                name: entry.name,
                type_text: body.text().into(),
            });
        }
    }
    let signatures: IndexMap<_, _> = ports
        .iter()
        .map(|port| (&port.name, &port.type_text))
        .collect();
    let mut used = IndexSet::new();
    for bag in &mut bags {
        for member in &mut bag.members {
            used.insert(member.type_text.clone());
            member.signature = signatures
                .get(&member.type_text)
                .map(|value| (*value).clone());
        }
    }
    bags.sort_by(|a, b| a.name.cmp(&b.name));
    let mut unbagged_ports: Vec<_> = ports
        .into_iter()
        .filter(|port| !used.contains(&port.name))
        .collect();
    unbagged_ports.sort_by(|a, b| a.name.cmp(&b.name));
    Ports {
        bags,
        unbagged_ports,
    }
}
