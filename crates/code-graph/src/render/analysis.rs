use crate::{
    project::locale_compare,
    render::{json::stable_stringify, text::number},
    schema::{Graph, UnreachableSymbol, WithheldSymbol},
    text::JsString,
};
use indexmap::IndexMap;
use serde::Serialize;

pub fn render_kinds(
    graph: &Graph,
    json: bool,
    pretty: bool,
) -> Result<JsString, serde_json::Error> {
    let census = crate::kinds::classify::kind_census(&graph.functions);
    if json {
        return stable_stringify(&census, pretty).map(Into::into);
    }
    let total = census.entry + census.auth + census.effect + census.plain;
    if total == 0 {
        return Ok("kinds: pass did not run — add --kinds (it implies --cross-runtime).".into());
    }
    Ok(format!("kinds: {} classified nodes\n  entry   {}\n  auth    {}\n  effect  {}\n  plain   {}   (unclassified — no declared rule matched)",number(total as f64),number(census.entry as f64),number(census.auth as f64),number(census.effect as f64),number(census.plain as f64)).into())
}
pub fn render_cross_runtime(
    graph: &Graph,
    json: bool,
    pretty: bool,
) -> Result<JsString, serde_json::Error> {
    use super::text::join;
    use crate::schema::{BindingKind, CrossRuntimeReason};
    let Some(report) = &graph.cross_runtime else {
        return Ok(
            "cross-runtime: pass did not run — add --cross-runtime (it implies the edge pass)."
                .into(),
        );
    };
    if json {
        return stable_stringify(report, pretty).map(Into::into);
    }
    let resolved = report
        .edges
        .iter()
        .filter(|edge| edge.callee_id.is_some())
        .count();
    let unresolved = report.edges.len() - resolved;
    let dead = report
        .census
        .iter()
        .filter(|row| row.call_sites == 0)
        .count();
    let mut lines = vec![format!("cross-runtime: {} binding call sites ({} resolved, {} unresolved) from {} wrangler configs",number(report.edges.len() as f64),number(resolved as f64),number(unresolved as f64),number(report.config_files.len() as f64)).into()];
    lines.extend(
        report
            .unparsed_configs
            .iter()
            .map(|file| format!("  UNPARSED CONFIG  {file}").into()),
    );
    if unresolved > 0 {
        lines.push(format!("unresolved ({}):", number(unresolved as f64)).into());
        for edge in report.edges.iter().filter(|edge| edge.callee_id.is_none()) {
            let reason = match edge.reason {
                Some(CrossRuntimeReason::TargetServiceUnknown) => "target-service-unknown",
                Some(CrossRuntimeReason::TargetNotLoaded) => "target-not-loaded",
                Some(CrossRuntimeReason::AmbiguousTarget) => "ambiguous-target",
                None => "null",
            };
            let mut line = JsString::from(format!("  {reason}  "));
            line.extend(&edge.owner_service);
            line.push_str(" → ");
            line.extend(&edge.target_service);
            line.push_str(".");
            line.extend(&edge.target_class);
            line.push_str(&format!(
                ".{}()  {}:{}",
                edge.method,
                edge.caller_id,
                number(edge.line as f64)
            ));
            lines.push(line);
        }
    }
    lines.push(
        format!(
            "declared bindings ({}, {} with no call site):",
            number(report.census.len() as f64),
            number(dead as f64)
        )
        .into(),
    );
    for row in &report.census {
        let kind = match row.binding_kind {
            BindingKind::Service => "service",
            BindingKind::DurableObject => "durable-object",
            BindingKind::Workflow => "workflow",
        };
        let mut line = JsString::from("  ");
        line.extend(&row.owner_service);
        line.push_str(".env.");
        line.extend(&row.binding);
        line.push_str(" → ");
        line.extend(&row.target_service);
        line.push_str(".");
        line.extend(&row.target_class);
        line.push_str(&format!(
            " [{kind}] {} call sites{}",
            number(row.call_sites as f64),
            if row.call_sites == 0 { "  UNUSED" } else { "" }
        ));
        lines.push(line);
    }
    Ok(join(lines, "\n"))
}
pub fn render_unguarded(
    graph: &Graph,
    json: bool,
    pretty: bool,
) -> Result<JsString, serde_json::Error> {
    use crate::schema::EntryReach;
    let Some(report) = &graph.reachability else {
        return Ok("reachability: pass did not run — add --unreachable or --unguarded.".into());
    };
    if json {
        return stable_stringify(&report.unguarded, pretty).map(Into::into);
    }
    let mut lines = vec![format!(
        "unguarded: {} effect nodes reachable from an entry without crossing an auth node ({} entries)",
        number(report.unguarded.len() as f64),
        number(report.entry_count as f64)
    )];
    for reach in EntryReach::ALL {
        let (name, heading) = match reach {
            EntryReach::Public => ("public", "reachable from a public entry"),
            EntryReach::ServiceBinding => (
                "service-binding",
                "reachable only through a service binding",
            ),
            EntryReach::Platform => (
                "platform",
                "reachable only from a platform trigger (cron, queue, tail)",
            ),
        };
        let rows: Vec<_> = report
            .unguarded
            .iter()
            .filter(|row| row.reach == reach)
            .collect();
        lines.push(format!(
            "  {name} ({}) — {heading}:",
            number(rows.len() as f64)
        ));
        for row in rows {
            lines.push(format!(
                "    {}  {}:{}",
                row.effect_id,
                row.file,
                number(row.start_line as f64)
            ));
            lines.push(format!(
                "      from {}  via {}",
                row.entry_id,
                row.path.join(" -> ")
            ));
        }
    }
    Ok(lines.join("\n").into())
}
fn file_list(files: &[String]) -> String {
    let shown = files.iter().take(8).cloned().collect::<Vec<_>>().join(", ");
    if files.len() > 8 {
        format!("{shown}, +{} more", number((files.len() - 8) as f64))
    } else {
        shown
    }
}
fn more_line(lines: &mut Vec<String>, total: usize) {
    if total > 20 {
        lines.push(format!(
            "  … and {} more (use --json for the full list)",
            number((total - 20) as f64)
        ));
    }
}
pub fn render_clusters(
    graph: &Graph,
    json: bool,
    pretty: bool,
) -> Result<JsString, serde_json::Error> {
    use crate::schema::ClusterAlgorithm;
    let Some(report) = &graph.clusters else {
        return Ok(
            "clusters: pass did not run — add --clusters (it implies --cross-runtime).".into(),
        );
    };
    if json {
        return stable_stringify(report, pretty).map(Into::into);
    }
    let algorithm = match report.algorithm {
        ClusterAlgorithm::LouvainDeterministic => "louvain-deterministic",
    };
    let mut lines = vec![
        format!(
            "clusters: {} communities over {} files (modularity {}, {}); {} isolated, {} test files excluded",
            number(report.cluster_count as f64),
            number(report.clustered_file_count as f64),
            number(report.modularity),
            algorithm,
            number(report.isolated_file_count as f64),
            number(report.excluded_test_file_count as f64)
        ),
        format!(
            "directories spanning multiple clusters ({}):",
            number(report.split_directories.len() as f64)
        ),
    ];
    for dir in report.split_directories.iter().take(20) {
        lines.push(format!(
            "  {}  {} clusters over {} files",
            dir.dir,
            number(dir.cluster_count as f64),
            number(dir.file_count as f64)
        ));
        for cluster in &dir.clusters {
            lines.push(format!(
                "    {}  {}",
                cluster.cluster_id,
                file_list(&cluster.files)
            ));
        }
        if !dir.isolated_files.is_empty() {
            lines.push(format!("    isolated  {}", file_list(&dir.isolated_files)));
        }
    }
    more_line(&mut lines, report.split_directories.len());
    lines.push(format!(
        "clusters scattered across directories ({}):",
        number(report.scattered_clusters.len() as f64)
    ));
    for cluster in report.scattered_clusters.iter().take(20) {
        lines.push(format!(
            "  {}  {} files over {} directories",
            cluster.id,
            number(cluster.size as f64),
            number(cluster.dir_count as f64)
        ));
        for dir in &cluster.dirs {
            lines.push(format!("    {}  {}", dir.dir, file_list(&dir.files)));
        }
    }
    more_line(&mut lines, report.scattered_clusters.len());
    Ok(lines.join("\n").into())
}
pub fn render_interface_width(
    graph: &Graph,
    json: bool,
    pretty: bool,
) -> Result<JsString, serde_json::Error> {
    let Some(report) = &graph.interface_width else {
        return Ok(
            "interface width: pass did not run — add --interface-width (implies the edge pass)."
                .into(),
        );
    };
    if json {
        return stable_stringify(report, pretty).map(Into::into);
    }
    let mut lines = vec![format!(
        "interface width: {} packages, {} exports, {} with zero external consumers (free deletions)",
        number(report.packages.len() as f64),
        number(report.total_exports as f64),
        number(report.total_zero_consumer as f64)
    )];
    for package in &report.packages {
        lines.push(format!(
            "  {}  {} exports, {} zero-consumer",
            if package.package.is_empty() {
                "."
            } else {
                &package.package
            },
            number(package.export_count as f64),
            number(package.zero_consumer_count as f64)
        ));
        for export in package
            .exports
            .iter()
            .filter(|row| row.external_consumers.is_empty())
        {
            lines.push(format!(
                "    ZERO-CONSUMER  {}  {}:{}",
                export.id,
                export.file,
                number(export.start_line as f64)
            ));
        }
    }
    Ok(lines.join("\n").into())
}
pub fn render_cycles(
    graph: &Graph,
    json: bool,
    pretty: bool,
    collation: &crate::project::Collation,
) -> Result<JsString, super::ReportRenderError> {
    if !matches!(graph.provenance, crate::schema::Provenance::Edges { .. }) {
        return Ok(
            "cycles: pass did not run — add --edges (the import graph needs the edge pass).".into(),
        );
    }
    let analysis = super::smells::coupling_of_graph(graph, collation)?;
    if json {
        return Ok(stable_stringify(&analysis.cycles, pretty)?.into());
    }
    if analysis.cycles.is_empty() {
        return Ok("cycles: none".into());
    }
    let mut lines = vec![format!(
        "cycles: {} dependency cycle(s) in the module import graph",
        number(analysis.cycles.len() as f64)
    )];
    for cycle in analysis.cycles {
        lines.push(format!(
            "  cycle of {}:",
            number(cycle.members.len() as f64)
        ));
        lines.extend(cycle.members.into_iter().map(|file| format!("    {file}")));
    }
    Ok(lines.join("\n").into())
}

pub fn render_unreachable(
    graph: &Graph,
    json: bool,
    pretty: bool,
) -> Result<JsString, serde_json::Error> {
    let Some(report) = &graph.reachability else {
        return Ok("reachability: pass did not run — add --unreachable or --unguarded.".into());
    };
    if json {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire<'a> {
            entry_count: &'a usize,
            unreachable: &'a [UnreachableSymbol],
            withheld: &'a [WithheldSymbol],
        }
        return stable_stringify(
            &Wire {
                entry_count: &report.entry_count,
                unreachable: &report.unreachable,
                withheld: &report.withheld,
            },
            pretty,
        )
        .map(Into::into);
    }
    let mut lines = vec![format!(
        "unreachable: {} of {} exported symbols ({} entries, {} nodes reachable)",
        number(report.unreachable.len() as f64),
        number(report.exported_count as f64),
        number(report.entry_count as f64),
        number(report.reachable_count as f64),
    )];
    for symbol in &report.unreachable {
        let witness = if symbol.test_references.is_empty() {
            String::new()
        } else {
            format!("  <- {}", symbol.test_references.join(", "))
        };
        lines.push(format!(
            "  {}  {}  {}:{}{witness}",
            symbol.category.as_str(),
            symbol.id,
            symbol.file,
            number(symbol.start_line as f64),
        ));
    }
    lines.push(format!(
        "withheld ({}) — an unmodelled construct may reach them:",
        number(report.withheld.len() as f64),
    ));
    let mut counts = IndexMap::new();
    for symbol in &report.withheld {
        *counts.entry(symbol.reason.as_str()).or_insert(0_usize) += 1;
    }
    let mut counts: Vec<_> = counts.into_iter().collect();
    counts.sort_by(|a, b| locale_compare(a.0, b.0));
    lines.extend(
        counts
            .into_iter()
            .map(|(reason, count)| format!("  {reason}  {}", number(count as f64))),
    );
    Ok(lines.join("\n").into())
}
