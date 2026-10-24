use super::rules::{CompiledRule, JsRegex, NodeKindRules, compile_group, matching_rules};
use crate::project::locale_compare_units;
use crate::schema::{EntryReach, FunctionNode, NodeKind};
use crate::text::JsString;
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;

#[derive(Default)]
pub struct ClassifyContext {
    pub cross_runtime_targets: IndexSet<String>,
    pub durable_object_methods: IndexSet<String>,
    pub base_class_entries: IndexMap<String, Vec<JsString>>,
    pub declared_guards: IndexMap<String, Vec<JsString>>,
    pub convention_entries: IndexMap<String, Vec<JsString>>,
}
pub struct ReachRule {
    pub reach: EntryReach,
    pub patterns: Vec<JsRegex>,
}
pub struct CompiledKindRules {
    pub entry_names: Vec<CompiledRule>,
    pub entry_base_classes: Vec<CompiledRule>,
    pub entry_guard_properties: Vec<CompiledRule>,
    pub entry_file_patterns: Vec<CompiledRule>,
    pub auth_names: Vec<CompiledRule>,
    pub auth_callees: Vec<CompiledRule>,
    pub effect_declarations: Vec<CompiledRule>,
    pub test_support: Vec<CompiledRule>,
    pub entry_reach: Vec<ReachRule>,
}
pub fn compile_kind_rules(rules: &NodeKindRules) -> Result<CompiledKindRules, regress::Error> {
    Ok(CompiledKindRules {
        entry_names: compile_group(&rules.entry_names)?,
        entry_base_classes: compile_group(&rules.entry_base_classes)?,
        entry_guard_properties: compile_group(&rules.entry_guard_properties)?,
        entry_file_patterns: compile_group(&rules.entry_file_patterns)?,
        auth_names: compile_group(&rules.auth_names)?,
        auth_callees: compile_group(&rules.auth_callees)?,
        effect_declarations: compile_group(&rules.effect_declarations)?,
        test_support: compile_group(&rules.test_support_file_patterns)?,
        entry_reach: vec![
            ReachRule {
                reach: EntryReach::ServiceBinding,
                patterns: rules
                    .entry_reach
                    .service_binding
                    .iter()
                    .map(JsRegex::new)
                    .collect::<Result<_, _>>()?,
            },
            ReachRule {
                reach: EntryReach::Platform,
                patterns: rules
                    .entry_reach
                    .platform
                    .iter()
                    .map(JsRegex::new)
                    .collect::<Result<_, _>>()?,
            },
        ],
    })
}
fn sorted(values: IndexSet<JsString>) -> Vec<JsString> {
    let mut values: Vec<_> = values.into_iter().collect();
    values.sort_by(|left, right| locale_compare_units(left.units(), right.units()));
    values
}
pub fn callee_simple_name(callee: &JsString) -> JsString {
    let units = callee.units();
    let units = if callee.starts_with("external:") {
        &units[9..]
    } else if callee.starts_with("unresolved:") {
        let rest = &units[11..];
        &rest[rest
            .iter()
            .rposition(|unit| *unit == u16::from(b'.'))
            .map_or(0, |index| index + 1)..]
    } else {
        let rest = &units[units
            .iter()
            .rposition(|unit| *unit == u16::from(b':'))
            .map_or(0, |index| index + 1)..];
        &rest[..rest
            .iter()
            .position(|unit| *unit == u16::from(b'#'))
            .unwrap_or(rest.len())]
    };
    JsString::from_units(units.to_vec())
}
fn callee_evidence(
    node: &FunctionNode,
    rules: &[CompiledRule],
    declarations: bool,
) -> Vec<JsString> {
    let mut out = IndexSet::new();
    for call in node.edges.iter().flat_map(|edges| &edges.calls) {
        let name = if declarations {
            let Some(name) = call.declaration.as_ref() else {
                continue;
            };
            name.clone()
        } else {
            callee_simple_name(&call.callee_id)
        };
        out.extend(matching_rules(rules, &name));
    }
    sorted(out)
}
pub fn classify_function(
    node: &FunctionNode,
    rules: &CompiledKindRules,
    context: &ClassifyContext,
) -> NodeKind {
    let mut entry = IndexSet::new();
    if !node.is_test {
        entry.extend(matching_rules(
            &rules.entry_names,
            &node.name.as_str().into(),
        ));
        if node.is_exported {
            entry.extend(matching_rules(
                &rules.entry_file_patterns,
                &node.file.as_str().into(),
            ));
        }
        if context.cross_runtime_targets.contains(&node.id) {
            entry.insert("cross-service-callee".into());
        }
        if context.durable_object_methods.contains(&node.id) {
            entry.insert("durable-object-class".into());
        }
        entry.extend(
            context
                .base_class_entries
                .get(&node.id)
                .into_iter()
                .flatten()
                .cloned(),
        );
        entry.extend(
            context
                .convention_entries
                .get(&node.id)
                .into_iter()
                .flatten()
                .cloned(),
        );
    }
    let entry = sorted(entry);
    if !entry.is_empty() {
        let reaches: Vec<_> = entry
            .iter()
            .map(|key| {
                rules
                    .entry_reach
                    .iter()
                    .find(|rule| rule.patterns.iter().any(|pattern| pattern.test(key)))
                    .map_or(EntryReach::Public, |rule| rule.reach)
            })
            .collect();
        let reach = EntryReach::ALL
            .into_iter()
            .find(|reach| reaches.contains(reach))
            .unwrap_or(EntryReach::Public);
        return NodeKind::Entry {
            evidence: entry,
            guards: context
                .declared_guards
                .get(&node.id)
                .cloned()
                .unwrap_or_default(),
            reach,
        };
    }
    let mut auth: IndexSet<_> = matching_rules(&rules.auth_names, &node.name.as_str().into())
        .into_iter()
        .collect();
    auth.extend(callee_evidence(node, &rules.auth_callees, false));
    let auth = sorted(auth);
    if !auth.is_empty() {
        return NodeKind::Auth { evidence: auth };
    }
    let effect = callee_evidence(node, &rules.effect_declarations, true);
    if !effect.is_empty() {
        return NodeKind::Effect { evidence: effect };
    }
    NodeKind::Plain
}
#[derive(Debug, Default, Serialize)]
pub struct KindCensus {
    pub entry: usize,
    pub auth: usize,
    pub effect: usize,
    pub plain: usize,
}
pub fn kind_census(functions: &[FunctionNode]) -> KindCensus {
    let mut census = KindCensus::default();
    for node in functions {
        match node.node_kind {
            Some(NodeKind::Entry { .. }) => census.entry += 1,
            Some(NodeKind::Auth { .. }) => census.auth += 1,
            Some(NodeKind::Effect { .. }) => census.effect += 1,
            Some(NodeKind::Plain) => census.plain += 1,
            None => {}
        }
    }
    census
}
