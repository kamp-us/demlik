use super::model::{Deployables, worker_of};
use crate::{
    boundaries::rules::interpolate,
    project::{Collation, CollationError, CollationInput},
    render::text::number,
    text::{JsString, JsValue, object_keys},
};
use indexmap::{IndexMap, IndexSet};
use serde::{Serialize, Serializer};

#[derive(Debug, Clone, Serialize)]
pub struct SiteRow {
    pub file: JsString,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub line: f64,
    pub binding: JsString,
}
#[derive(Debug, Serialize)]
pub struct WorkerCensus<'rows> {
    pub worker: JsString,
    pub files: Vec<JsString>,
    #[serde(serialize_with = "serialize_counts")]
    pub bindings: IndexMap<JsString, f64>,
    pub sites: Vec<&'rows SiteRow>,
}
fn serialize_counts<S: Serializer>(
    counts: &IndexMap<JsString, f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    JsValue::Object(
        counts
            .iter()
            .map(|(key, count)| (key.clone(), JsValue::Number(*count)))
            .collect(),
    )
    .serialize(serializer)
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployableCensus<'rows> {
    pub workers: Vec<WorkerCensus<'rows>>,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub unresolved_service_bindings: f64,
}
fn worker_row<'rows>(
    worker: JsString,
    rows: Vec<&'rows SiteRow>,
    collation: &Collation,
) -> Result<WorkerCensus<'rows>, CollationError> {
    let mut counts: IndexMap<JsString, usize> = IndexMap::new();
    for row in &rows {
        *counts.entry(row.binding.clone()).or_insert(0) += 1;
    }
    let mut files = rows
        .iter()
        .map(|row| row.file.clone())
        .collect::<IndexSet<_>>()
        .into_iter()
        .map(|file| CollationInput::from_utf16(file.units()).map(|input| (file, input)))
        .collect::<Result<Vec<_>, _>>()?;
    files.sort_by(|a, b| collation.compare(&a.1, &b.1));
    let files = files.into_iter().map(|(file, _)| file).collect();
    let mut counts = counts
        .into_iter()
        .map(|(name, count)| {
            CollationInput::from_utf16(name.units()).map(|input| (name, count, input))
        })
        .collect::<Result<Vec<_>, _>>()?;
    counts.sort_by(|a, b| collation.compare(&a.2, &b.2));
    let inputs = rows
        .iter()
        .map(|row| {
            Ok((
                CollationInput::from_utf16(row.file.units())?,
                CollationInput::from_utf16(row.binding.units())?,
            ))
        })
        .collect::<Result<Vec<_>, CollationError>>()?;
    let order = crate::text::v8_sort::permutation(rows.len(), |a, b| {
        collation
            .compare(&inputs[a].0, &inputs[b].0)
            .then_with(|| {
                rows[a]
                    .line
                    .partial_cmp(&rows[b].line)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| collation.compare(&inputs[a].1, &inputs[b].1))
    });
    Ok(WorkerCensus {
        worker,
        files,
        bindings: counts
            .into_iter()
            .map(|(name, count, _)| (name, count as f64))
            .collect(),
        sites: order.into_iter().map(|index| rows[index]).collect(),
    })
}
pub fn deployable_census<'rows>(
    deployables: &Deployables<'_>,
    rows: impl IntoIterator<Item = &'rows SiteRow>,
    collation: &Collation,
) -> Result<Option<DeployableCensus<'rows>>, CollationError> {
    if deployables.kinds.is_empty() {
        return Ok(None);
    }
    let mut by_worker: IndexMap<JsString, Vec<&SiteRow>> = IndexMap::new();
    for row in rows {
        if let Some(worker) = worker_of(deployables, &row.file) {
            by_worker
                .entry(worker.service.clone())
                .or_default()
                .push(row);
        }
    }
    let mut by_worker = by_worker
        .into_iter()
        .map(|(worker, rows)| {
            CollationInput::from_utf16(worker.units()).map(|input| (worker, rows, input))
        })
        .collect::<Result<Vec<_>, _>>()?;
    by_worker.sort_by(|a, b| collation.compare(&a.2, &b.2));
    Ok(Some(DeployableCensus {
        workers: by_worker
            .into_iter()
            .map(|(worker, rows, _)| worker_row(worker, rows, collation))
            .collect::<Result<_, _>>()?,
        unresolved_service_bindings: deployables.graph.unresolved as f64,
    }))
}
fn count(n: f64, noun: &str) -> JsString {
    format!("{} {noun}{}", number(n), if n == 1.0 { "" } else { "s" }).into()
}
fn joined(parts: impl IntoIterator<Item = JsString>, separator: &str) -> JsString {
    let mut out = JsString::default();
    for (index, part) in parts.into_iter().enumerate() {
        if index > 0 {
            out.push_str(separator);
        }
        out.extend(&part);
    }
    out
}
pub fn deployable_census_lines(census: &DeployableCensus<'_>) -> Vec<JsString> {
    let sites: usize = census.workers.iter().map(|row| row.sites.len()).sum();
    let mut lines = vec![interpolate(&[
        "deployables: ".into(),
        count(census.workers.len() as f64, "worker"),
        " using bindings, ".into(),
        count(sites as f64, "site"),
        ", ".into(),
        count(census.unresolved_service_bindings, "service binding"),
        " to a worker with no config in the repo".into(),
    ])];
    lines.extend(census.workers.iter().map(|row| {
        let names = joined(
            object_keys(&row.bindings).into_iter().map(|name| {
                interpolate(&[
                    name.clone(),
                    format!(" {}", number(row.bindings[name])).into(),
                ])
            }),
            ", ",
        );
        interpolate(&[
            "  ".into(),
            row.worker.clone(),
            ": ".into(),
            count(row.sites.len() as f64, "site"),
            " in ".into(),
            count(row.files.len() as f64, "file"),
            " over ".into(),
            count(row.bindings.len() as f64, "binding"),
            " (".into(),
            names,
            ")".into(),
        ])
    }));
    lines
}
