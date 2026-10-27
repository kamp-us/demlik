use crate::{
    project::locale_compare,
    render::{json::stable_stringify, text::number},
    schema::{Graph, UnreachableSymbol, WithheldSymbol},
    text::JsString,
};
use indexmap::IndexMap;
use serde::Serialize;

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
