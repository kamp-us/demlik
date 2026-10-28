use super::{ChurnData, ChurnWindow, churn_for};
use crate::{
    project::{Collation, CollationError, CollationInput},
    render::{ReportRenderError, json::stable_stringify, text::number},
    schema::Graph,
    text::{JsString, JsValue},
};
use indexmap::IndexMap;
use serde::{Serialize, Serializer};
use std::cmp::Ordering;

#[derive(Debug, Serialize)]
pub struct HotspotRow {
    pub file: JsString,
    #[serde(serialize_with = "option_number")]
    pub churn: Option<f64>,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub complexity: f64,
    #[serde(serialize_with = "option_number")]
    pub product: Option<f64>,
}
fn option_number<S: Serializer>(value: &Option<f64>, out: S) -> Result<S::Ok, S::Error> {
    value.map_or(JsValue::Null, JsValue::Number).serialize(out)
}
fn entries(
    modules: impl IntoIterator<Item = JsString>,
    functions: impl IntoIterator<Item = (JsString, f64)>,
    churn: &ChurnData,
    collation: &Collation,
) -> Result<Vec<HotspotRow>, CollationError> {
    let mut totals = IndexMap::new();
    for (file, complexity) in functions {
        *totals.entry(file).or_insert(0.0) += complexity;
    }
    let mut rows = modules
        .into_iter()
        .map(|file| {
            let complexity = totals.get(&file).copied().unwrap_or(0.0);
            let churn = churn_for(churn, &file);
            HotspotRow {
                file,
                churn,
                complexity,
                product: churn.map(|value| value * complexity),
            }
        })
        .collect::<Vec<_>>();
    let inputs = rows
        .iter()
        .map(|row| CollationInput::from_utf16(row.file.units()))
        .collect::<Result<Vec<_>, _>>()?;
    let order = crate::text::v8_sort::permutation(rows.len(), |left, right| {
        match (rows[left].product, rows[right].product) {
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (left_product, right_product) => {
                let numeric = match (left_product, right_product) {
                    (Some(a), Some(b)) => (b - a).partial_cmp(&0.0).unwrap_or(Ordering::Equal),
                    _ => Ordering::Equal,
                };
                numeric.then_with(|| collation.compare(&inputs[left], &inputs[right]))
            }
        }
    });
    let mut destinations = vec![0; rows.len()];
    for (destination, source) in order.into_iter().enumerate() {
        destinations[source] = destination;
    }
    for index in 0..rows.len() {
        while destinations[index] != index {
            let destination = destinations[index];
            rows.swap(index, destination);
            destinations.swap(index, destination);
        }
    }
    Ok(rows)
}
/// Canonical extracted Graph profile: borrow the original graph and read its
/// measured String/usize facts; only fresh output primitive values are owned.
pub fn compute_hotspots(
    graph: &Graph,
    churn: &ChurnData,
    collation: &Collation,
) -> Result<Vec<HotspotRow>, CollationError> {
    entries(
        graph
            .modules
            .iter()
            .map(|module| module.file.as_str().into()),
        graph
            .functions
            .iter()
            .map(|function| (function.file.as_str().into(), function.complexity as f64)),
        churn,
        collation,
    )
}
/// Authored raw Number/UTF16 profile, separate from canonical Graph's field types.
pub fn compute_hotspots_from_parts<'a>(
    modules: impl IntoIterator<Item = &'a JsString>,
    functions: impl IntoIterator<Item = (&'a JsString, f64)>,
    churn: &ChurnData,
    collation: &Collation,
) -> Result<Vec<HotspotRow>, CollationError> {
    entries(
        modules.into_iter().cloned(),
        functions
            .into_iter()
            .map(|(file, value)| (file.clone(), value)),
        churn,
        collation,
    )
}
fn slice_end(limit: f64, length: usize) -> usize {
    if limit.is_nan() || limit == 0.0 || limit == f64::NEG_INFINITY {
        return 0;
    }
    if limit == f64::INFINITY {
        return length;
    }
    let integer = limit.trunc();
    if integer < 0.0 {
        (length as f64 + integer).max(0.0) as usize
    } else {
        integer.min(length as f64) as usize
    }
}
fn minimum(limit: f64, length: usize) -> f64 {
    if limit.is_nan() {
        f64::NAN
    } else {
        limit.min(length as f64)
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report<'a> {
    window: &'a ChurnWindow,
    head_sha: &'a JsString,
    rows: &'a [HotspotRow],
    no_history_count: usize,
}
/// Render the already computed rows without narrowing a public Number limit.
pub fn render_hotspot_rows(
    rows: &[HotspotRow],
    head_sha: &JsString,
    window: &ChurnWindow,
    limit: f64,
    json: bool,
    pretty: bool,
) -> Result<JsString, serde_json::Error> {
    let no_history_count = rows.iter().filter(|row| row.product.is_none()).count();
    let report = Report {
        window,
        head_sha,
        rows,
        no_history_count,
    };
    if json {
        return stable_stringify(&report, pretty).map(Into::into);
    }
    let ranked = rows
        .iter()
        .filter(|row| row.product.is_some())
        .collect::<Vec<_>>();
    let mut result = JsString::from("Churn × complexity hotspots — window ");
    result.extend(&window.since_iso);
    result.push_str(" .. ");
    result.extend(&window.until_iso);
    result.push_str(&format!(" ({} days), HEAD ", number(window.days)));
    result.extend(head_sha);
    result.push_str(&format!("\ntop {} of {} ranked ({} file(s) have no git history — excluded from ranking, listed separately)", number(minimum(limit, ranked.len())), number(ranked.len() as f64), number(no_history_count as f64)));
    if ranked.is_empty() && no_history_count == 0 {
        result.push_str("\nNo files in scope.");
        return Ok(result);
    }
    result.push_str("\n");
    for (index, row) in ranked
        .into_iter()
        .take(slice_end(limit, rows.len() - no_history_count))
        .enumerate()
    {
        if index > 0 {
            result.push_str("\n");
        }
        result.push_str(&format!("{:>3}. ", index + 1));
        result.extend(&row.file);
        result.push_str(&format!(
            "  churn={} complexity={} product={}",
            row.churn.map_or_else(|| "no-history".into(), number),
            number(row.complexity),
            row.product.map_or_else(|| "—".into(), number)
        ));
    }
    if no_history_count > 0 {
        result.push_str(&format!(
            "\nno git history ({}):\n",
            number(no_history_count as f64)
        ));
        for (index, row) in rows.iter().filter(|row| row.product.is_none()).enumerate() {
            if index > 0 {
                result.push_str("\n");
            }
            result.push_str("  ");
            result.extend(&row.file);
        }
    }
    Ok(result)
}
pub fn render_hotspots(
    graph: &Graph,
    churn: &ChurnData,
    window: &ChurnWindow,
    limit: f64,
    json: bool,
    pretty: bool,
    collation: &Collation,
) -> Result<JsString, ReportRenderError> {
    let rows = compute_hotspots(graph, churn, collation)?;
    Ok(render_hotspot_rows(
        &rows,
        &churn.head_sha,
        window,
        limit,
        json,
        pretty,
    )?)
}
