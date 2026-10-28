use super::{
    ReportRenderError,
    json::stable_stringify,
    text::{join, number},
};
use crate::{
    project::{Collation, discover_package_roots, resolve_path_text_from},
    schema::{Graph, Severity, SmellTarget},
    smells::coupling::{CouplingAnalysis, analyze_coupling},
    text::JsString,
};
use std::{collections::HashMap, path::Path};
pub(crate) fn coupling_of_graph(
    graph: &Graph,
    collation: &Collation,
) -> Result<CouplingAnalysis, ReportRenderError> {
    let root = resolve_path_text_from(&JsString::default(), &graph.root)?;
    let roots = discover_package_roots(Path::new(&root.to_lossy()), None);
    Ok(analyze_coupling(&graph.modules, &roots, collation)?)
}
fn render_coupling(graph: &Graph, collation: &Collation) -> Result<JsString, ReportRenderError> {
    let analysis = coupling_of_graph(graph, collation)?;
    let cross_out: HashMap<_, _> = analysis
        .ranked
        .iter()
        .map(|row| (row.file.as_str(), row.cross_boundary_out_count))
        .collect();
    let cycles: Vec<_> = analysis
        .cycles
        .iter()
        .filter(|cycle| cycle.members.len() as u64 > graph.thresholds.dependency_cycle)
        .collect();
    let groups: Vec<_> = analysis
        .cross_boundary
        .iter()
        .filter_map(|group| {
            let edges: Vec<_> = group
                .edges
                .iter()
                .filter(|edge| {
                    cross_out.get(edge.from.as_str()).copied().unwrap_or(0) as u64
                        > graph.thresholds.cross_boundary_imports
                })
                .collect();
            (!edges.is_empty()).then_some((group, edges))
        })
        .collect();
    if cycles.is_empty() && groups.is_empty() {
        return Ok(JsString::default());
    }
    let mut lines = vec![JsString::from("Coupling")];
    if !cycles.is_empty() {
        lines.push(format!("  Dependency cycles ({}):", number(cycles.len() as f64)).into());
        for cycle in cycles {
            lines.push(format!("    [{}]", cycle.members.join(", ")).into());
        }
    }
    if !groups.is_empty() {
        lines.push(
            format!(
                "  Cross-boundary edges ({}):",
                number(groups.iter().map(|(_, edges)| edges.len()).sum::<usize>() as f64)
            )
            .into(),
        );
        for (group, edges) in groups {
            lines.push(
                format!(
                    "    {} → {} ({})",
                    group.from,
                    group.to,
                    number(edges.len() as f64)
                )
                .into(),
            );
            for edge in edges {
                lines.push(format!("      {} → {}", edge.from, edge.to).into());
            }
        }
    }
    let ranked: Vec<_> = analysis
        .ranked
        .iter()
        .filter(|row| {
            row.cycle_size as u64 > graph.thresholds.dependency_cycle
                || row.cross_boundary_out_count as u64 > graph.thresholds.cross_boundary_imports
        })
        .collect();
    if !ranked.is_empty() {
        lines.push("  Worst-coupled modules:".into());
        for row in ranked.into_iter().take(10) {
            lines.push(
                format!(
                    "    {}  score={} (cycle={} cross={})",
                    row.file,
                    number(row.score as f64),
                    number(row.cycle_size as f64),
                    number(row.cross_boundary_out_count as f64)
                )
                .into(),
            );
        }
    }
    Ok(join(lines, "\n"))
}
pub fn render_smells(
    graph: &Graph,
    json: bool,
    pretty: bool,
    collation: &Collation,
) -> Result<JsString, ReportRenderError> {
    if json {
        return Ok(stable_stringify(&graph.smells, pretty)?.into());
    }
    let coupling = render_coupling(graph, collation)?;
    if graph.smells.is_empty() {
        return Ok(if coupling.is_empty() {
            "No smells found.".into()
        } else {
            coupling
        });
    }
    let mut kinds: Vec<_> = graph
        .smells
        .iter()
        .map(|smell| smell.kind.as_str())
        .collect();
    kinds.sort();
    kinds.dedup();
    let mut lines = Vec::new();
    for kind in kinds {
        let group: Vec<_> = graph
            .smells
            .iter()
            .filter(|smell| smell.kind.as_str() == kind)
            .collect();
        lines.push(format!("{kind} ({})", number(group.len() as f64)).into());
        for smell in group {
            let locator = match &smell.target {
                SmellTarget::Function {
                    id,
                    file,
                    start_line,
                } => format!("{id} ({file}:{})", number(*start_line as f64)),
                SmellTarget::Module { file } => file.clone(),
                SmellTarget::Directory { dir } => dir.clone(),
            };
            let severity = match smell.severity {
                Severity::High => "high",
                Severity::Warn => "warn",
            };
            lines.push(
                format!(
                    "  [{severity}] {locator}  value={} threshold={}",
                    number(smell.value as f64),
                    number(smell.threshold as f64)
                )
                .into(),
            );
        }
        lines.push(JsString::default());
    }
    if !coupling.is_empty() {
        lines.push(coupling);
    }
    Ok(join(lines, "\n").trim_js())
}
