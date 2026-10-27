use super::{
    analyze::{LayerEdge, LayerReport},
    reconcile::{MiscountedEdge, Reconciliation, reconcile},
    rules::AllowedEdge,
};
use crate::{
    project::{Collation, CollationError},
    render::{json::stable_stringify, text::join},
    text::JsString,
};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerRender {
    pub stdout: JsString,
    pub exit_code: u8,
}
fn edge_line(edge: &LayerEdge) -> JsString {
    let mut out = JsString::from("  ");
    out.extend(&edge.from);
    out.push_str(&format!(":{}  ", edge.from_line));
    out.extend(&edge.from_layer);
    out.push_str(" -> ");
    out.extend(&edge.to_layer);
    out.push_str("  ");
    out.extend(&edge.to);
    out.push_str(&format!(":{}  (\"", edge.to_line));
    out.extend(&edge.specifier);
    out.push_str("\")");
    if edge.type_only {
        out.push_str("  [type-only]");
    }
    out
}
fn allowed_line(entry: &AllowedEdge) -> JsString {
    let mut out = JsString::from("  ");
    out.extend(&entry.from);
    out.push_str(" -> ");
    out.extend(&entry.to);
    out.push_str(&format!("  ({} sites)", entry.sites));
    out
}
fn header_lines(report: &LayerReport) -> Vec<JsString> {
    let mut stack = JsString::from("layers: ");
    stack.extend(&join(report.layers.iter().cloned(), " > "));
    let c = &report.census;
    let mut lines = vec![
        stack,
        format!(
            concat!(
                "scanned {} files — {} down, {} sideways, {} UP, ",
                "{} unlayered, {} external, {} unresolved"
            ),
            report.files_scanned, c.down, c.sideways, c.up, c.unlayered, c.external, c.unresolved,
        )
        .into(),
    ];
    for unresolved in &report.unresolved {
        let mut line = JsString::from("  UNRESOLVED  ");
        line.extend(unresolved);
        lines.push(line);
    }
    lines.push(
        format!(
            "violations ({} upward import sites):",
            report.violations.len()
        )
        .into(),
    );
    lines
}
fn verdict_lines(result: &Reconciliation<'_>) -> Vec<JsString> {
    if result.passed {
        return vec![
            format!(
                concat!(
                    "allowlist: OK — {} violating site(s), every one declared, ",
                    "and no declared entry is stale."
                ),
                result.allowed_sites,
            )
            .into(),
        ];
    }
    let mut lines = vec![JsString::from("LAYER GATE FAILED.")];
    if !result.undeclared.is_empty() {
        lines.push(
            format!(
                "  {} undeclared violation(s) — an edge points UP the stack:",
                result.undeclared.len()
            )
            .into(),
        );
        lines.extend(result.undeclared.iter().map(|edge| edge_line(edge)));
        lines.extend([
            "  Fix: point the dependency down (move the shared thing into a lower layer, or".into(),
            "  invert it behind a contract). If it cannot move in this PR, add the pair to the"
                .into(),
            "  `allowed` array in your --layer-rules file with its exact site count and a reason."
                .into(),
        ]);
    }
    if !result.stale.is_empty() {
        lines.push(
            format!(
                "  {} declared violation(s) no longer exist — a closed violation",
                result.stale.len()
            )
            .into(),
        );
        lines.push(
            "  must not keep its excuse, or the ratchet turns back into a baseline file:".into(),
        );
        lines.extend(result.stale.iter().map(|entry| allowed_line(entry)));
        lines.push(
            "  Fix: delete those entries from the `allowed` array in your --layer-rules file."
                .into(),
        );
    }
    if !result.miscounted.is_empty() {
        lines.push(
            format!(
                "  {} declared violation(s) changed size — a new import on a",
                result.miscounted.len()
            )
            .into(),
        );
        lines.push(
            "  known-bad pair is still new drift, and a removed one is still progress:".into(),
        );
        for entry in &result.miscounted {
            let mut line = JsString::from("  ");
            line.extend(&entry.declared.from);
            line.push_str(" -> ");
            line.extend(&entry.declared.to);
            line.push_str(&format!(
                "  declared {}, found {}",
                entry.declared.sites, entry.actual
            ));
            lines.push(line);
        }
        lines.push("  Fix: update `sites` in the `allowed` array in your --layer-rules file, or remove the import.".into());
    }
    lines
}
#[derive(Debug)]
pub enum LayerRenderError {
    Collation(CollationError),
    Json(serde_json::Error),
}
impl std::fmt::Display for LayerRenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Collation(error) => error.fmt(f),
            Self::Json(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for LayerRenderError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Collation(error) => error,
            Self::Json(error) => error,
        })
    }
}
pub fn render_layers(
    report: &LayerReport,
    allowed: &[AllowedEdge],
    json: bool,
    pretty: bool,
    collation: &Collation,
) -> Result<LayerRender, LayerRenderError> {
    let result = reconcile(report, allowed, collation).map_err(LayerRenderError::Collation)?;
    let exit_code = if result.passed { 0 } else { 1 };
    if json {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct JsonReport<'a> {
            layers: &'a [JsString],
            files_scanned: usize,
            census: &'a super::analyze::LayerCensus,
            unresolved: &'a [JsString],
            violations: &'a [LayerEdge],
            passed: bool,
            undeclared: &'a [&'a LayerEdge],
            stale: &'a [&'a AllowedEdge],
            miscounted: &'a [MiscountedEdge<'a>],
        }
        let output = JsonReport {
            layers: &report.layers,
            files_scanned: report.files_scanned,
            census: &report.census,
            unresolved: &report.unresolved,
            violations: &report.violations,
            passed: result.passed,
            undeclared: &result.undeclared,
            stale: &result.stale,
            miscounted: &result.miscounted,
        };
        return Ok(LayerRender {
            stdout: stable_stringify(&output, pretty)
                .map_err(LayerRenderError::Json)?
                .into(),
            exit_code,
        });
    }
    let mut lines = header_lines(report);
    lines.extend(report.violations.iter().map(edge_line));
    lines.extend(verdict_lines(&result));
    Ok(LayerRender {
        stdout: join(lines, "\n"),
        exit_code,
    })
}
