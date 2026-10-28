use crate::extract::scc::{scc_members, strongly_connected_components};
use crate::project::{Collation, CollationError, CollationInput};
use crate::schema::ModuleNode;
use indexmap::IndexMap;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CouplingFacts {
    pub boundary: String,
    pub cycle_size: usize,
    pub cross_boundary_out_count: usize,
}
#[derive(Serialize)]
pub struct ValueEdge {
    pub from: String,
    pub to: String,
}
#[derive(Serialize)]
pub struct Cycle {
    pub members: Vec<String>,
}
#[derive(Serialize)]
pub struct CrossBoundaryGroup {
    pub from: String,
    pub to: String,
    pub edges: Vec<ValueEdge>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleRank {
    pub file: String,
    pub cycle_size: usize,
    pub cross_boundary_out_count: usize,
    pub score: usize,
}
pub struct CouplingAnalysis {
    pub cycles: Vec<Cycle>,
    pub cross_boundary: Vec<CrossBoundaryGroup>,
    pub ranked: Vec<ModuleRank>,
    pub coupling: IndexMap<String, CouplingFacts>,
}
pub fn boundary_of(file: &str, package_roots: &[String]) -> String {
    let mut best = "";
    for root in package_roots {
        if !root.is_empty()
            && (file == root
                || file
                    .strip_prefix(root)
                    .is_some_and(|rest| rest.starts_with('/')))
            && root.len() > best.len()
        {
            best = root;
        }
    }
    best.into()
}
pub fn value_edges(
    modules: &[ModuleNode],
    collation: &Collation,
) -> Result<Vec<ValueEdge>, CollationError> {
    value_edges_of(modules.iter(), collation)
}
pub(crate) fn value_edges_of<'a>(
    modules: impl Iterator<Item = &'a ModuleNode>,
    collation: &Collation,
) -> Result<Vec<ValueEdge>, CollationError> {
    let modules: Vec<_> = modules.collect();
    let known: HashSet<_> = modules.iter().map(|module| module.file.as_str()).collect();
    let mut seen = HashSet::new();
    let mut edges = Vec::new();
    for module in &modules {
        for edge in &module.import_edges {
            let Some(target) = &edge.target else {
                continue;
            };
            if edge.type_only
                || target == &module.file
                || !known.contains(target.as_str())
                || !seen.insert(format!("{}\t{target}", module.file))
            {
                continue;
            }
            edges.push(ValueEdge {
                from: module.file.clone(),
                to: target.clone(),
            });
        }
    }
    let mut edges = edges
        .into_iter()
        .map(|edge| {
            let from = CollationInput::from_text(&edge.from)?;
            let to = CollationInput::from_text(&edge.to)?;
            Ok((edge, from, to))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    edges.sort_by(|left, right| {
        collation
            .compare(&left.1, &right.1)
            .then_with(|| collation.compare(&left.2, &right.2))
    });
    Ok(edges.into_iter().map(|(edge, _, _)| edge).collect())
}
pub fn coupling_by_file(
    modules: &[ModuleNode],
    package_roots: &[String],
    collation: &Collation,
) -> Result<IndexMap<String, CouplingFacts>, CollationError> {
    let edges = value_edges(modules, collation)?;
    let cycles = cycles_of(modules, &edges, collation)?;
    Ok(coupling_of(modules, edges.iter(), &cycles, package_roots))
}
fn cycles_of(
    modules: &[ModuleNode],
    edges: &[ValueEdge],
    collation: &Collation,
) -> Result<Vec<Cycle>, CollationError> {
    let mut nodes = modules
        .iter()
        .map(|module| {
            Ok((
                module.file.clone(),
                CollationInput::from_text(&module.file)?,
            ))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    nodes.sort_by(|left, right| collation.compare(&left.1, &right.1));
    let nodes = nodes.into_iter().map(|(node, _)| node).collect::<Vec<_>>();
    let mut adjacency: IndexMap<String, Vec<String>> = nodes
        .iter()
        .map(|node| (node.clone(), Vec::new()))
        .collect();
    for edge in edges {
        if let Some(targets) = adjacency.get_mut(&edge.from) {
            targets.push(edge.to.clone());
        }
    }
    let components = strongly_connected_components(&nodes, &adjacency);
    let mut cycles: Vec<_> = scc_members(&nodes, &components)
        .into_values()
        .filter(|members| members.len() >= 2)
        .map(|members| {
            let mut members = members
                .into_iter()
                .map(|member| {
                    let key = CollationInput::from_text(&member)?;
                    Ok((member, key))
                })
                .collect::<Result<Vec<_>, CollationError>>()?;
            members.sort_by(|a, b| collation.compare(&a.1, &b.1));
            let members = members
                .into_iter()
                .map(|(member, _)| member)
                .collect::<Vec<_>>();
            let key = CollationInput::from_text(&members[0])?;
            Ok((Cycle { members }, key))
        })
        .collect::<Result<_, CollationError>>()?;
    cycles.sort_by(|a, b| collation.compare(&a.1, &b.1));
    Ok(cycles.into_iter().map(|(cycle, _)| cycle).collect())
}
pub fn find_cycles(
    modules: &[ModuleNode],
    collation: &Collation,
) -> Result<Vec<Cycle>, CollationError> {
    cycles_of(modules, &value_edges(modules, collation)?, collation)
}
fn cross_boundary_of(
    edges: Vec<ValueEdge>,
    package_roots: &[String],
    collation: &Collation,
) -> Result<Vec<CrossBoundaryGroup>, CollationError> {
    let mut groups: IndexMap<String, CrossBoundaryGroup> = IndexMap::new();
    for edge in edges {
        let from = boundary_of(&edge.from, package_roots);
        let to = boundary_of(&edge.to, package_roots);
        if from == to {
            continue;
        }
        groups
            .entry(format!("{from}\t{to}"))
            .or_insert_with(|| CrossBoundaryGroup {
                from,
                to,
                edges: vec![],
            })
            .edges
            .push(edge);
    }
    let mut groups = groups
        .into_values()
        .map(|mut group| {
            let mut edges = group
                .edges
                .into_iter()
                .map(|edge| {
                    let from = CollationInput::from_text(&edge.from)?;
                    let to = CollationInput::from_text(&edge.to)?;
                    Ok((edge, from, to))
                })
                .collect::<Result<Vec<_>, CollationError>>()?;
            edges.sort_by(|a, b| {
                collation
                    .compare(&a.1, &b.1)
                    .then_with(|| collation.compare(&a.2, &b.2))
            });
            group.edges = edges.into_iter().map(|(edge, _, _)| edge).collect();
            let from = CollationInput::from_text(&group.from)?;
            let to = CollationInput::from_text(&group.to)?;
            Ok((group, from, to))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    groups.sort_by(|a, b| {
        collation
            .compare(&a.1, &b.1)
            .then_with(|| collation.compare(&a.2, &b.2))
    });
    Ok(groups.into_iter().map(|(group, _, _)| group).collect())
}
pub fn cross_boundary_edges(
    modules: &[ModuleNode],
    package_roots: &[String],
    collation: &Collation,
) -> Result<Vec<CrossBoundaryGroup>, CollationError> {
    cross_boundary_of(value_edges(modules, collation)?, package_roots, collation)
}
fn coupling_of<'a>(
    modules: &[ModuleNode],
    edges: impl Iterator<Item = &'a ValueEdge>,
    cycles: &[Cycle],
    package_roots: &[String],
) -> IndexMap<String, CouplingFacts> {
    let mut cycle_sizes = HashMap::new();
    for cycle in cycles {
        for member in &cycle.members {
            cycle_sizes.insert(member.as_str(), cycle.members.len());
        }
    }
    let mut cross_out = HashMap::new();
    for edge in edges {
        if boundary_of(&edge.from, package_roots) != boundary_of(&edge.to, package_roots) {
            *cross_out.entry(edge.from.as_str()).or_insert(0usize) += 1;
        }
    }
    modules
        .iter()
        .map(|module| {
            (
                module.file.clone(),
                CouplingFacts {
                    boundary: boundary_of(&module.file, package_roots),
                    cycle_size: cycle_sizes.get(module.file.as_str()).copied().unwrap_or(0),
                    cross_boundary_out_count: cross_out
                        .get(module.file.as_str())
                        .copied()
                        .unwrap_or(0),
                },
            )
        })
        .collect()
}
fn rank_of(
    modules: &[ModuleNode],
    coupling: &IndexMap<String, CouplingFacts>,
    collation: &Collation,
) -> Result<Vec<ModuleRank>, CollationError> {
    let ranked: Vec<_> = modules
        .iter()
        .filter_map(|module| {
            let facts = coupling.get(&module.file)?;
            let score = facts.cycle_size + facts.cross_boundary_out_count;
            (score != 0).then(|| ModuleRank {
                file: module.file.clone(),
                cycle_size: facts.cycle_size,
                cross_boundary_out_count: facts.cross_boundary_out_count,
                score,
            })
        })
        .collect();
    let mut ranked = ranked
        .into_iter()
        .map(|row| {
            let key = CollationInput::from_text(&row.file)?;
            Ok((row, key))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    ranked.sort_by(|a, b| {
        b.0.score
            .cmp(&a.0.score)
            .then_with(|| collation.compare(&a.1, &b.1))
    });
    Ok(ranked.into_iter().map(|(row, _)| row).collect())
}
pub fn rank_modules(
    modules: &[ModuleNode],
    package_roots: &[String],
    collation: &Collation,
) -> Result<Vec<ModuleRank>, CollationError> {
    rank_of(
        modules,
        &coupling_by_file(modules, package_roots, collation)?,
        collation,
    )
}
pub fn analyze_coupling(
    modules: &[ModuleNode],
    package_roots: &[String],
    collation: &Collation,
) -> Result<CouplingAnalysis, CollationError> {
    let edges = value_edges(modules, collation)?;
    let cycles = cycles_of(modules, &edges, collation)?;
    let cross_boundary = cross_boundary_of(edges, package_roots, collation)?;
    // Coupling counts only cross-boundary rows. Groups retain every contributing
    // original edge, including rows sharing a literal-tab group key.
    let coupling = coupling_of(
        modules,
        cross_boundary.iter().flat_map(|group| group.edges.iter()),
        &cycles,
        package_roots,
    );
    let ranked = rank_of(modules, &coupling, collation)?;
    Ok(CouplingAnalysis {
        cycles,
        cross_boundary,
        ranked,
        coupling,
    })
}
