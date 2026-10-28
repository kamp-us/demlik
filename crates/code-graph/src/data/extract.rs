use super::alias_scope::AliasScopes;
use crate::{
    extract::{
        cross_runtime::owner_of,
        functions::DiscoveredFunction,
        wrangler_config::{BindingCatalog, CatalogError, load_binding_catalog},
    },
    project::{SourceUnit, locale_compare, locale_compare_units, to_relative},
    schema::{DataEdge, DataReport, DataSite, UnattributedDataSite},
    syntax::file::{NodeIdentity, NodeRef, SyntaxFile},
    text::JsString,
};
use indexmap::IndexMap;
use serde::Serialize;
use std::{collections::HashMap, path::Path, rc::Rc};

#[derive(Debug, Serialize)]
pub struct Site<'a, D> {
    pub decl: &'a D,
    pub method: Option<JsString>,
    pub sql: Option<JsString>,
    pub line: usize,
    pub column: usize,
}
fn env_receiver(node: NodeRef<'_>) -> bool {
    if node.kind() == "Identifier" {
        return node.string("name") == Some("env");
    }
    node.kind() == "MemberExpression"
        && node.boolean("computed") != Some(true)
        && node.node("property").is_some_and(|property| {
            property.kind() == "Identifier" && property.string("name") == Some("env")
        })
}
fn key_name(holder: NodeRef<'_>, key: Option<NodeRef<'_>>) -> Option<JsString> {
    let key = key?;
    if holder.boolean("computed") != Some(true) {
        return (key.kind() == "Identifier")
            .then(|| key.string("name").unwrap_or("undefined").into());
    }
    if key.kind() != "Literal" {
        return None;
    }
    key.string_units("value")
        .map(|units| JsString::from_units(units.into_owned()))
}
fn member_name(node: NodeRef<'_>) -> Option<JsString> {
    key_name(node, node.node("property"))
}
fn env_binding<'a, D>(node: NodeRef<'_>, bindings: &'a IndexMap<JsString, D>) -> Option<&'a D> {
    if node.kind() != "MemberExpression" || !env_receiver(node.node("object")?) {
        return None;
    }
    bindings.get(&member_name(node)?)
}
fn local_name(node: Option<NodeRef<'_>>) -> Option<&str> {
    let node = node?;
    let node = if node.kind() == "AssignmentPattern" {
        node.node("left")?
    } else {
        node
    };
    (node.kind() == "Identifier").then(|| node.string("name").unwrap_or("undefined"))
}
fn declare_aliases<'a, D>(
    node: NodeRef<'_>,
    bindings: &'a IndexMap<JsString, D>,
    aliases: &mut AliasScopes<'a, D>,
) {
    if node.kind() != "VariableDeclarator" {
        return;
    }
    let (Some(id), Some(init)) = (node.node("id"), node.node("init")) else {
        return;
    };
    if id.kind() == "ObjectPattern" && env_receiver(init) {
        for property in id.nodes("properties") {
            if property.kind() != "Property" {
                continue;
            }
            if let (Some(decl), Some(local)) = (
                key_name(property, property.node("key")).and_then(|key| bindings.get(&key)),
                local_name(property.node("value")),
            ) {
                aliases.bind(local, decl);
            }
        }
    } else if id.kind() == "Identifier"
        && let Some(decl) = env_binding(init, bindings)
    {
        aliases.bind(id.string("name").unwrap_or("undefined"), decl);
    }
}
fn alias_initializer(node: NodeRef<'_>) -> bool {
    node.parent().is_some_and(|parent| {
        parent.kind() == "VariableDeclarator"
            && parent.node("init") == Some(node)
            && parent
                .node("id")
                .is_some_and(|id| id.kind() == "Identifier")
    })
}
fn alias_use(node: NodeRef<'_>) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    match parent.kind() {
        "MemberExpression" => parent.node("object") == Some(node),
        "CallExpression" | "NewExpression" => parent.nodes("arguments").contains(&node),
        _ => false,
    }
}
fn referenced_binding<'a, D>(
    node: NodeRef<'_>,
    bindings: &'a IndexMap<JsString, D>,
    aliases: &AliasScopes<'a, D>,
) -> Option<&'a D> {
    match node.kind() {
        "MemberExpression" if !alias_initializer(node) => env_binding(node, bindings),
        "Identifier" if alias_use(node) => {
            aliases.resolve(node.string("name").unwrap_or("undefined"))
        }
        _ => None,
    }
}
fn literal_text(node: NodeRef<'_>) -> Option<JsString> {
    match node.kind() {
        "Literal" => node.string_units("value"),
        "TemplateLiteral" => node
            .nodes("quasis")
            .first()?
            .string_units_path(&["value", "cooked"]),
        _ => None,
    }
    .map(|units| JsString::from_units(units.into_owned()))
}
fn first_argument_text(member: NodeRef<'_>) -> Option<JsString> {
    let call = member.parent()?;
    if call.kind() != "CallExpression" || call.node("callee") != Some(member) {
        return None;
    }
    literal_text(*call.nodes("arguments").first()?)
}
fn site_at<'a, D>(node: NodeRef<'_>, decl: &'a D) -> Site<'a, D> {
    let member = node.parent().filter(|parent| {
        parent.kind() == "MemberExpression" && parent.node("object") == Some(node)
    });
    Site {
        decl,
        method: member.and_then(member_name),
        sql: member.and_then(first_argument_text),
        line: node.start_line(),
        column: node.start_column(),
    }
}
pub fn binding_sites<'a, D>(
    syntax: &SyntaxFile,
    bindings: &'a IndexMap<JsString, D>,
) -> Vec<Site<'a, D>> {
    sites_of(syntax, &HashMap::new(), bindings)
        .into_iter()
        .map(|held| held.site)
        .collect()
}
struct Held<'a, 'holder, D> {
    holder: Option<&'holder DiscoveredFunction>,
    site: Site<'a, D>,
}
fn sites_of<'decl, 'holder, D>(
    syntax: &SyntaxFile,
    holders: &HashMap<NodeIdentity, &'holder DiscoveredFunction>,
    bindings: &'decl IndexMap<JsString, D>,
) -> Vec<Held<'decl, 'holder, D>> {
    fn enter<'decl, 'holder, D>(
        node: NodeRef<'_>,
        outer: Option<&'holder DiscoveredFunction>,
        holders: &HashMap<NodeIdentity, &'holder DiscoveredFunction>,
        bindings: &'decl IndexMap<JsString, D>,
        aliases: &mut AliasScopes<'decl, D>,
        sites: &mut Vec<Held<'decl, 'holder, D>>,
    ) {
        let holder = holders.get(&node.identity()).copied().or(outer);
        let opened = aliases.enter(node);
        declare_aliases(node, bindings, aliases);
        if let Some(decl) = referenced_binding(node, bindings, aliases) {
            sites.push(Held {
                holder,
                site: site_at(node, decl),
            });
        }
        for child in node.children() {
            enter(child, holder, holders, bindings, aliases, sites);
        }
        aliases.leave(opened);
    }
    let mut aliases = AliasScopes::new();
    let mut sites = Vec::new();
    enter(
        syntax.root(),
        None,
        holders,
        bindings,
        &mut aliases,
        &mut sites,
    );
    sites
}

fn compare_sites(left: &DataSite, right: &DataSite) -> std::cmp::Ordering {
    left.line
        .cmp(&right.line)
        .then_with(|| left.column.cmp(&right.column))
        .then_with(|| locale_compare_units(left.binding.units(), right.binding.units()))
        .then_with(|| {
            locale_compare_units(
                left.method.as_ref().map_or(&[], JsString::units),
                right.method.as_ref().map_or(&[], JsString::units),
            )
        })
        .then_with(|| locale_compare(left.access.as_str(), right.access.as_str()))
}
fn distinct<T>(
    rows: Vec<T>,
    site: impl Fn(&T) -> &DataSite,
    holder: impl Fn(&T) -> &str,
) -> Vec<T> {
    let mut seen = IndexMap::new();
    for row in rows {
        let fields = site(&row);
        let key = (
            holder(&row).to_owned(),
            fields.line,
            fields.column,
            fields.binding.clone(),
            fields.method.clone(),
        );
        seen.insert(key, row);
    }
    let mut out = seen.into_values().collect::<Vec<_>>();
    out.sort_by(|left, right| {
        locale_compare(holder(left), holder(right))
            .then_with(|| compare_sites(site(left), site(right)))
    });
    out
}
#[derive(Debug, Serialize)]
pub struct DataScan {
    pub edges: Vec<DataEdge>,
    pub unattributed: Vec<UnattributedDataSite>,
}
pub struct DataScanInput<'a> {
    pub units: &'a [Rc<SourceUnit>],
    pub functions: &'a [DiscoveredFunction],
    pub catalog: &'a BindingCatalog,
    pub repo_root: &'a Path,
}
pub fn scan_data_sites(input: DataScanInput<'_>) -> DataScan {
    let holders = input
        .functions
        .iter()
        .map(|function| (function.node().identity(), function))
        .collect::<HashMap<_, _>>();
    let mut edges = Vec::new();
    let mut unattributed = Vec::new();
    for unit in input.units {
        let Some(owner) = owner_of(
            &input.catalog.manifests,
            &to_relative(input.repo_root, &unit.absolute_path),
        ) else {
            continue;
        };
        if owner.data_bindings.is_empty() {
            continue;
        }
        let bindings = owner
            .data_bindings
            .iter()
            .map(|decl| (decl.binding.clone(), decl))
            .collect();
        for Held { holder, site } in sites_of(&unit.syntax, &holders, &bindings) {
            let Site {
                decl,
                method,
                sql,
                line,
                column,
            } = site;
            let row = DataSite {
                line,
                column,
                owner_service: owner.service.clone(),
                binding: decl.binding.clone(),
                binding_kind: decl.kind,
                access: super::access::access_of(decl.kind, method.as_ref(), sql.as_ref()),
                method,
            };
            if let Some(holder) = holder {
                edges.push(DataEdge {
                    site: row,
                    function_id: holder.id.clone(),
                });
            } else {
                unattributed.push(UnattributedDataSite {
                    site: row,
                    file: unit.file.clone(),
                });
            }
        }
    }
    DataScan {
        edges: distinct(edges, |edge| &edge.site, |edge| &edge.function_id),
        unattributed: distinct(unattributed, |row| &row.site, |row| &row.file),
    }
}
pub fn load_data_report(
    units: &[Rc<SourceUnit>],
    functions: &[DiscoveredFunction],
    repo_root: &Path,
    collation: &crate::project::Collation,
) -> Result<DataReport, CatalogError> {
    let catalog = load_binding_catalog(repo_root, None, collation)?;
    let scan = scan_data_sites(DataScanInput {
        units,
        functions,
        catalog: &catalog,
        repo_root,
    });
    let mut config_files = catalog
        .manifests
        .iter()
        .map(|manifest| manifest.config_file.clone())
        .collect::<Vec<_>>();
    config_files.sort_by(|left, right| locale_compare(left, right));
    Ok(DataReport {
        config_files,
        unparsed_configs: catalog.unparsed_configs,
        edges: scan.edges,
        unattributed: scan.unattributed,
    })
}
