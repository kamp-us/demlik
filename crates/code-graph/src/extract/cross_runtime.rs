use super::callee::resolve::ResolvedCallee;
use super::wrangler_config::{BindingCatalog, BindingDecl, ServiceManifest};
use crate::checker::context::TypeContext;
use crate::engine::tsgo::{NativeNode, TsgoError};
use crate::project::{locale_compare, locale_compare_units};
use crate::schema::{BindingKind, CrossRuntimeEdge, CrossRuntimeReason};
use crate::text::JsString;
use indexmap::{IndexMap, IndexSet};
use std::path::Path;

pub fn owner_of<'a>(
    manifests: &'a [ServiceManifest],
    repo_relative_file: &str,
) -> Option<&'a ServiceManifest> {
    owner_of_text(manifests, &repo_relative_file.into())
}

pub fn owner_of_text<'a>(
    manifests: &'a [ServiceManifest],
    repo_relative_file: &JsString,
) -> Option<&'a ServiceManifest> {
    let mut best: Option<&ServiceManifest> = None;
    for manifest in manifests {
        let prefix = if manifest.dir.is_empty() {
            String::new()
        } else {
            format!("{}/", manifest.dir)
        };
        if repo_relative_file.starts_with(&prefix)
            && best.is_none_or(|best| manifest.dir.len() > best.dir.len())
        {
            best = Some(manifest);
        }
    }
    best
}

fn enclosing_class_name(
    context: &TypeContext<'_, '_>,
    node: &NativeNode,
) -> Result<Option<JsString>, TsgoError> {
    let Some(parent) = node.parent()? else {
        return Ok(None);
    };
    if parent.is_kind("ClassDeclaration") {
        return Ok(Some(
            parent
                .node("name")?
                .map(|name| name.literal_text())
                .transpose()?
                .flatten()
                .unwrap_or_else(|| "default".into()),
        ));
    }
    if parent.is_kind("ClassExpression") {
        if let Some(name) = parent.node("name")? {
            return name.literal_text();
        }
        if let Some(owner) = parent
            .parent()?
            .filter(|node| node.is_kind("VariableDeclaration"))
        {
            return Ok(Some(context.text(&owner.required_node("name")?)?.into()));
        }
    }
    Ok(None)
}

fn class_names_of(
    context: &TypeContext<'_, '_>,
    method: &NativeNode,
) -> Result<Vec<JsString>, TsgoError> {
    let Some(class_name) = enclosing_class_name(context, method)? else {
        return Ok(Vec::new());
    };
    let mut names = vec![class_name.clone()];
    for statement in method.source_file().root().nodes("statements")? {
        if !statement.is_kind("VariableStatement") {
            continue;
        }
        for variable in statement
            .required_node("declarationList")?
            .nodes("declarations")?
        {
            let Some(initializer) = variable
                .node("initializer")?
                .filter(|node| node.is_kind("CallExpression"))
            else {
                continue;
            };
            let mut wraps_class = false;
            for argument in initializer.nodes("arguments")? {
                if argument.is_kind("Identifier") && class_name == context.text(&argument)? {
                    wraps_class = true;
                    break;
                }
            }
            if wraps_class {
                names.push(context.text(&variable.required_node("name")?)?.into());
            }
        }
    }
    Ok(names)
}

pub fn method_ids_of_classes(
    context: &TypeContext<'_, '_>,
    class_names: &IndexSet<JsString>,
) -> Result<IndexSet<String>, TsgoError> {
    let mut ids = IndexSet::new();
    for (node, id) in &context.node_to_id {
        if node.is_kind("MethodDeclaration")
            && class_names_of(context, node)?
                .iter()
                .any(|name| class_names.contains(name))
        {
            ids.insert(id.clone());
        }
    }
    Ok(ids)
}

fn method_key(dir: &str, class_name: &JsString, method: &str) -> JsString {
    let mut key = JsString::from(dir);
    key.push_str("|");
    key.extend(class_name);
    key.push_str("|");
    key.push_str(method);
    key
}

fn ancestor_dirs(file: &str) -> Vec<String> {
    let parts: Vec<_> = file.split('/').collect();
    let mut dirs = vec![String::new()];
    let mut accumulated = String::new();
    for part in &parts[..parts.len().saturating_sub(1)] {
        if accumulated.is_empty() {
            accumulated.push_str(part);
        } else {
            accumulated.push('/');
            accumulated.push_str(part);
        }
        dirs.push(accumulated.clone());
    }
    dirs
}

pub struct CrossRuntimeInput<'a> {
    pub catalog: &'a BindingCatalog,
    pub root_absolute: &'a Path,
    pub repo_root: &'a Path,
}
pub struct CrossRuntimeResolver<'a> {
    catalog: &'a BindingCatalog,
    root_posix: String,
    repo_prefix: String,
    index: IndexMap<JsString, Vec<String>>,
    service_directories: IndexMap<JsString, Option<String>>,
    collected: Vec<CrossRuntimeEdge>,
}
pub fn create_cross_runtime_resolver<'a>(
    input: CrossRuntimeInput<'a>,
    context: &TypeContext<'_, '_>,
) -> Result<CrossRuntimeResolver<'a>, TsgoError> {
    let mut resolver = CrossRuntimeResolver {
        catalog: input.catalog,
        root_posix: input
            .root_absolute
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/"),
        repo_prefix: format!(
            "{}/",
            input
                .repo_root
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/")
        ),
        index: IndexMap::new(),
        service_directories: IndexMap::new(),
        collected: Vec::new(),
    };
    for (node, id) in &context.node_to_id {
        if !node.is_kind("MethodDeclaration") {
            continue;
        }
        let source = node.source_file();
        let absolute = context.unit_of(&source).map_or_else(
            || source.file_name().to_path_buf(),
            |unit| unit.absolute_path.clone(),
        );
        let absolute = absolute
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/");
        let repo_file = resolver.to_repo_relative(&absolute);
        for class_name in class_names_of(context, node)? {
            for dir in ancestor_dirs(repo_file) {
                resolver
                    .index
                    .entry(method_key(
                        &dir,
                        &class_name,
                        &context.text(&node.required_node("name")?)?,
                    ))
                    .or_default()
                    .push(id.clone());
            }
        }
    }
    for bucket in resolver.index.values_mut() {
        bucket.sort_by(|left, right| locale_compare(left, right));
    }
    for manifest in &input.catalog.manifests {
        if resolver.service_directories.contains_key(&manifest.service) {
            resolver
                .service_directories
                .insert(manifest.service.clone(), None);
        } else {
            resolver
                .service_directories
                .insert(manifest.service.clone(), Some(manifest.dir.clone()));
        }
    }
    Ok(resolver)
}

fn invoked_method(declaration: &BindingDecl, called: &str) -> Option<String> {
    match declaration.kind {
        BindingKind::Service | BindingKind::DurableObject => Some(called.to_owned()),
        BindingKind::Workflow => ["create", "createBatch"]
            .contains(&called)
            .then(|| "run".to_owned()),
    }
}

impl CrossRuntimeResolver<'_> {
    fn to_repo_relative<'a>(&self, absolute: &'a str) -> &'a str {
        absolute.strip_prefix(&self.repo_prefix).unwrap_or(absolute)
    }
    pub fn resolve(
        &mut self,
        context: &TypeContext<'_, '_>,
        call: &NativeNode,
        caller_id: &str,
        caller_file: &str,
    ) -> Result<Option<ResolvedCallee>, TsgoError> {
        let method = call.required_node("expression")?;
        if !method.is_kind("PropertyAccessExpression") {
            return Ok(None);
        }
        let receiver = method.required_node("expression")?;
        if !receiver.is_kind("PropertyAccessExpression") {
            return Ok(None);
        }
        let binding = JsString::from(context.text(&receiver.required_node("name")?)?);
        let called = context.text(&method.required_node("name")?)?;
        let absolute = format!("{}/{caller_file}", self.root_posix).replace("/./", "/");
        let repo_file = self.to_repo_relative(&absolute);
        let Some(owner) = owner_of(&self.catalog.manifests, repo_file) else {
            return Ok(None);
        };
        let Some(declaration) = owner
            .bindings
            .iter()
            .find(|declaration| declaration.binding == binding)
        else {
            return Ok(None);
        };
        let Some(target_method) = invoked_method(declaration, &called) else {
            return Ok(None);
        };
        let directory = self
            .service_directories
            .get(&declaration.target_service)
            .and_then(Option::as_ref);
        let (callee_id, reason) = if let Some(directory) = directory {
            let hits = self.index.get(&method_key(
                directory,
                &declaration.target_class,
                &target_method,
            ));
            match hits.map(Vec::as_slice).unwrap_or_default() {
                [] => (None, Some(CrossRuntimeReason::TargetNotLoaded)),
                [id] => (Some(id.clone()), None),
                _ => (None, Some(CrossRuntimeReason::AmbiguousTarget)),
            }
        } else {
            (None, Some(CrossRuntimeReason::TargetServiceUnknown))
        };
        self.collected.push(CrossRuntimeEdge {
            binding: declaration.binding.clone(),
            binding_kind: declaration.kind,
            caller_id: caller_id.to_owned(),
            callee_id: callee_id.clone(),
            line: context.start_line(call)?,
            method: called.clone(),
            owner_service: owner.service.clone(),
            reason,
            target_class: declaration.target_class.clone(),
            target_service: declaration.target_service.clone(),
        });
        let resolved = if let Some(id) = callee_id {
            ResolvedCallee {
                callee_id: id.into(),
                declaration: None,
            }
        } else {
            let mut id = JsString::from("unresolved:");
            id.extend(&declaration.target_service);
            id.push_str(".");
            id.extend(&declaration.target_class);
            id.push_str(".");
            id.push_str(&called);
            let mut qualified = declaration.target_service.clone();
            qualified.push_str(":");
            qualified.extend(&declaration.target_class);
            qualified.push_str(".");
            qualified.push_str(&called);
            ResolvedCallee {
                callee_id: id,
                declaration: Some(qualified),
            }
        };
        Ok(Some(resolved))
    }
    pub fn edges(&self) -> Vec<CrossRuntimeEdge> {
        let mut seen = IndexSet::new();
        let mut edges: Vec<_> = self
            .collected
            .iter()
            .filter(|edge| {
                let mut key = JsString::from(format!("{}|{}|", edge.caller_id, edge.line));
                key.extend(&edge.binding);
                key.push_str("|");
                key.push_str(&edge.method);
                seen.insert(key)
            })
            .cloned()
            .collect();
        edges.sort_by(|left, right| {
            locale_compare(&left.caller_id, &right.caller_id)
                .then_with(|| left.line.cmp(&right.line))
                .then_with(|| locale_compare_units(left.binding.units(), right.binding.units()))
                .then_with(|| locale_compare(&left.method, &right.method))
        });
        edges
    }
}
