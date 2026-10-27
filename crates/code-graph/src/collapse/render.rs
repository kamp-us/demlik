use super::{
    candidates::{CollapseCandidate, CollapseCluster, CollapseReport, find_collapse_candidates},
    partial::PartialTwin,
    settings::CollapseSettings,
};
use crate::{
    project::discover_package_roots,
    render::{
        json::stable_stringify,
        text::{join, number, pad_start},
    },
    schema::{Graph, Provenance},
    text::JsString,
};
use std::path::Path;

const HUMAN_LIMIT: usize = 20;
const SKIPPED_SHOWN: usize = 5;
const BLOCK_SHOWN: usize = 4;

fn cost_line(candidate: &CollapseCandidate<'_>) -> JsString {
    let c = candidate.cost_inputs;
    format!(
        "     cost={}  callers={} packages={}{}{}",
        number(candidate.cost),
        c.caller_union,
        c.packages_spanned,
        if c.crosses_package {
            " cross-package"
        } else {
            ""
        },
        if c.effect_on_path {
            " effect-on-path"
        } else {
            ""
        },
    )
    .into()
}
fn format_cluster(cluster: &CollapseCluster<'_>, index: usize) -> JsString {
    let candidate = &cluster.representative;
    let position = pad_start(&(index + 1).to_string(), 3);
    let mut lines = vec![
        format!(
            "{position}. rank={}  confidence={}{}",
            number(candidate.rank),
            number(candidate.confidence),
            if cluster.pair_count > 1 {
                format!(
                    "  cluster of {} ({} pairs)",
                    cluster.members.len(),
                    cluster.pair_count
                )
            } else {
                String::new()
            }
        )
        .into(),
        format!(
            "     A {}  {}:{}",
            candidate.a.id, candidate.a.file, candidate.a.start_line
        )
        .into(),
        format!(
            "     B {}  {}:{}",
            candidate.b.id, candidate.b.file, candidate.b.start_line
        )
        .into(),
        cost_line(candidate),
    ];
    for signal in &candidate.signals {
        let mut line: JsString = format!(
            "     + {} {}  ",
            signal.signal.as_str(),
            number(signal.strength)
        )
        .into();
        line.extend(&signal.detail);
        lines.push(line);
    }
    let rest = cluster
        .members
        .iter()
        .copied()
        .filter(|id| *id != candidate.a.id && *id != candidate.b.id)
        .collect::<Vec<_>>();
    if !rest.is_empty() {
        lines.push(format!("     also: {}", rest.join(", ")).into());
    }
    join(lines, "\n")
}

/// The suffix after the final colon, retaining the input's UTF-16 units.
pub fn short_callee_name(callee_id: &JsString) -> JsString {
    let units = callee_id.units();
    let external: Vec<_> = "external:".encode_utf16().collect();
    let bare = units.strip_prefix(external.as_slice()).unwrap_or(units);
    let start = bare
        .iter()
        .rposition(|u| *u == b':' as u16)
        .map_or(0, |at| at + 1);
    JsString::from_units(bare[start..].to_vec())
}
fn block_line(twin: &PartialTwin<'_>) -> JsString {
    let mut line: JsString =
        format!("     shared block ({} calls)  ", twin.shared_block.len()).into();
    line.extend(&join(
        twin.shared_block
            .iter()
            .take(BLOCK_SHOWN)
            .map(|call| short_callee_name(&call.callee_id)),
        " -> ",
    ));
    if twin.shared_block.len() > BLOCK_SHOWN {
        line.push_str(&format!(
            " -> +{} more",
            twin.shared_block.len() - BLOCK_SHOWN
        ));
    }
    line
}
fn format_partial_twin(twin: &PartialTwin<'_>, index: usize) -> JsString {
    let position = pad_start(&(index + 1).to_string(), 3);
    let mut divergence: JsString = "     DIVERGES: A calls ".into();
    divergence.extend(&short_callee_name(&twin.a_diverges.callee_id));
    divergence.push_str(&format!(
        " ({}:{})  B calls ",
        twin.a.file, twin.a_diverges.line
    ));
    divergence.extend(&short_callee_name(&twin.b_diverges.callee_id));
    divergence.push_str(&format!(" ({}:{})", twin.b.file, twin.b_diverges.line));
    join(
        vec![
            format!(
                "{position}. block={}  constants={}",
                twin.shared_block.len(),
                twin.shared_constants.len()
            )
            .into(),
            format!(
                "     A {}  {}:{}",
                twin.a.id, twin.a.file, twin.shared_block[0].line
            )
            .into(),
            format!(
                "     B {}  {}:{}",
                twin.b.id,
                twin.b.file,
                twin.b_block_line()
            )
            .into(),
            block_line(twin),
            format!(
                "     shared constants  {}",
                twin.shared_constants.join(", ")
            )
            .into(),
            divergence,
        ],
        "\n",
    )
}

/// Fresh human report lines over the original partial-twin views.
pub fn partial_twin_lines(report: &CollapseReport<'_, '_>) -> Vec<JsString> {
    if report.partial_twins.is_empty() {
        return vec![
            "partial twins: 0 — no shared decision block diverges on the same named constants"
                .into(),
        ];
    }
    let mut lines = vec![
        format!("partial twins: {} — one decision block over the same named constants, two different outcomes",report.partial_twins.len()).into(),
        "GATEABLE (--collapse --ci) — each is intended and said so in the PR body, or it is a defect".into(),
    ];
    lines.extend(
        report
            .partial_twins
            .iter()
            .take(HUMAN_LIMIT)
            .enumerate()
            .map(|(i, twin)| format_partial_twin(twin, i)),
    );
    lines
}
fn skipped_lines(report: &CollapseReport<'_, '_>) -> Vec<JsString> {
    if report.skipped_blocks.is_empty() {
        return vec![];
    }
    let mut lines = vec![format!("skipped {} blocking keys over maxBlockSize={} — pairs sharing ONLY one of these were never scored:",report.skipped_blocks.len(),number(report.settings.max_block_size)).into()];
    for block in report.skipped_blocks.iter().take(SKIPPED_SHOWN) {
        let mut line: JsString = format!("  {}  ", block.kind.as_str()).into();
        line.extend(&block.key);
        line.push_str(&format!("  {} members", block.size));
        lines.push(line);
    }
    lines
}
fn render_human(report: &CollapseReport<'_, '_>) -> JsString {
    let shown = HUMAN_LIMIT.min(report.clusters.len());
    let mut lines = vec![
        format!("collapse candidates: {} findings / {} pairs (top {shown} shown) from {} scored over {} functions, minSignals={}",report.clusters.len(),report.candidates.len(),report.pairs_scored,report.considered_functions,number(report.settings.min_signals)).into(),
        "a REPORT, not a gate — the graph narrows, a human judges".into(),
    ];
    lines.extend(skipped_lines(report));
    lines.extend(
        report
            .clusters
            .iter()
            .take(HUMAN_LIMIT)
            .enumerate()
            .map(|(i, cluster)| format_cluster(cluster, i)),
    );
    lines.push(JsString::default());
    lines.extend(partial_twin_lines(report));
    join(lines, "\n")
}

/// Render a canonical graph without copying its facts. Package discovery uses blocking Git/FS IO.
/// The result has no final newline; CLI emission owns that byte.
pub fn render_collapse(
    graph: &Graph,
    root_absolute: &JsString,
    settings: &CollapseSettings,
    json: bool,
    pretty: bool,
) -> Result<JsString, serde_json::Error> {
    if !matches!(graph.provenance, Provenance::Edges { .. }) {
        return Ok("collapse: needs the call graph; add --edges (--collapse implies it).".into());
    }
    let native_root = root_absolute.to_lossy();
    let roots = discover_package_roots(Path::new(&native_root), None);
    let report = find_collapse_candidates(&graph.functions, &roots, settings);
    if json {
        stable_stringify(&report, pretty).map(Into::into)
    } else {
        Ok(render_human(&report))
    }
}
