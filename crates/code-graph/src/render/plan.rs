use super::{
    json::stable_stringify,
    text::{number, pad_start},
};
use crate::{
    schema::Graph,
    smells::plan::{PlanAxis, rank_plan},
    text::JsString,
};
pub fn render_plan(
    graph: &Graph,
    axis: PlanAxis,
    json: bool,
    pretty: bool,
) -> Result<JsString, serde_json::Error> {
    let rows = rank_plan(&graph.functions, axis);
    if json {
        return stable_stringify(&rows, pretty).map(Into::into);
    }
    if rows.is_empty() {
        return Ok(format!("No refactor targets (--by {}).", axis.as_str()).into());
    }
    let mut lines = vec![format!(
        "Refactor plan — ranked by {} (top {} of {})",
        axis.as_str(),
        number(rows.len().min(20) as f64),
        number(rows.len() as f64)
    )];
    for (index, row) in rows.iter().take(20).enumerate() {
        let kinds = row
            .smells
            .iter()
            .map(|smell| smell.kind.as_str())
            .collect::<Vec<_>>()
            .join(",");
        lines.push(format!(
            "{}. {}\n     {}:{}-{}\n     loc={} cx={} fanIn={} smells={} score={}\n     [{}]",
            pad_start(&number((index + 1) as f64), 3),
            row.id,
            row.file,
            number(row.start_line as f64),
            number(row.end_line as f64),
            number(row.loc as f64),
            number(row.complexity as f64),
            row.called_by_count
                .map(|n| number(n as f64))
                .unwrap_or_else(|| "—".into()),
            number(row.components.smells as f64),
            number(row.score as f64),
            if kinds.is_empty() { "—" } else { &kinds }
        ));
    }
    Ok(lines.join("\n").into())
}
