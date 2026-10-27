use super::{
    settings::CollapseSettings,
    signals::{Twin, round4},
};
use crate::{
    query::reach::{Adjacency, invoked_adjacency, reachable_from},
    schema::{FunctionNode, NodeKind},
};
use indexmap::{IndexMap, IndexSet};
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostInputs {
    pub caller_union: usize,
    pub packages_spanned: usize,
    pub crosses_package: bool,
    pub effect_on_path: bool,
}
pub(super) struct CostContext<'g, 'p> {
    roots: Vec<&'p str>,
    file_of: IndexMap<&'g str, &'g str>,
    reaches_effect: IndexSet<String>,
}
impl<'g, 'p> CostContext<'g, 'p> {
    pub fn new(functions: &'g [FunctionNode], package_roots: &'p [String]) -> Self {
        let mut roots: Vec<_> = package_roots.iter().map(String::as_str).collect();
        roots.sort_by_key(|p| std::cmp::Reverse(p.encode_utf16().count()));
        let forward = invoked_adjacency(functions);
        let mut reverse = Adjacency::new();
        for (from, tos) in forward {
            for to in tos {
                reverse.entry(to).or_default().push(from.clone());
            }
        }
        let seeds: IndexSet<_> = functions
            .iter()
            .filter(|f| matches!(f.node_kind, Some(NodeKind::Effect { .. })))
            .map(|f| f.id.clone())
            .collect();
        let reaches_effect = reachable_from(&reverse, &seeds.into_iter().collect::<Vec<_>>());
        Self {
            roots,
            file_of: functions
                .iter()
                .map(|f| (f.id.as_str(), f.file.as_str()))
                .collect(),
            reaches_effect,
        }
    }
    fn package_of(&self, file: &str) -> &str {
        for root in &self.roots {
            if root.is_empty()
                || file == *root
                || file
                    .strip_prefix(root)
                    .is_some_and(|tail| tail.starts_with('/'))
            {
                return root;
            }
        }
        ""
    }
    pub fn inputs(&self, a: &Twin<'g>, b: &Twin<'g>) -> CostInputs {
        let callers: IndexSet<_> = a.callers.iter().chain(&b.callers).copied().collect();
        let a_package = self.package_of(&a.function.file);
        let b_package = self.package_of(&b.function.file);
        let mut packages = IndexSet::from([a_package, b_package]);
        for caller in &callers {
            if let Some(file) = self.file_of.get(caller) {
                packages.insert(self.package_of(file));
            }
        }
        CostInputs {
            caller_union: callers.len(),
            packages_spanned: packages.len(),
            crosses_package: a_package != b_package,
            effect_on_path: self.reaches_effect.contains(&a.function.id)
                || self.reaches_effect.contains(&b.function.id),
        }
    }
}
pub(super) fn collapse_cost(c: CostInputs, s: &CollapseSettings) -> f64 {
    round4(
        1.0 + s.cost_caller_weight * libm::log2(1.0 + c.caller_union as f64)
            + s.cost_package_weight * (c.packages_spanned as f64 - 1.0).max(0.0)
            + if c.crosses_package {
                s.cost_cross_package_weight
            } else {
                0.0
            }
            + if c.effect_on_path {
                s.cost_effect_weight
            } else {
                0.0
            },
    )
}
