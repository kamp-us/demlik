use super::model::{Deployables, worker_of};
use crate::{
    boundaries::rules::interpolate,
    project::locale_compare_units,
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
pub struct WorkerCensus {
    pub worker: JsString,
    pub files: Vec<JsString>,
    #[serde(serialize_with = "serialize_counts")]
    pub bindings: IndexMap<JsString, usize>,
    pub sites: Vec<SiteRow>,
}
fn serialize_counts<S: Serializer>(
    counts: &IndexMap<JsString, usize>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    JsValue::Object(
        counts
            .iter()
            .map(|(key, count)| (key.clone(), JsValue::Number(*count as f64)))
            .collect(),
    )
    .serialize(serializer)
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployableCensus {
    pub workers: Vec<WorkerCensus>,
    pub unresolved_service_bindings: usize,
}
fn worker_row(worker: JsString, rows: Vec<&SiteRow>) -> WorkerCensus {
    let mut counts: IndexMap<JsString, usize> = IndexMap::new();
    for row in &rows {
        *counts.entry(row.binding.clone()).or_insert(0) += 1;
    }
    counts.sort_by(|a, _, b, _| locale_compare_units(a.units(), b.units()));
    let mut files: Vec<_> = rows
        .iter()
        .map(|row| row.file.clone())
        .collect::<IndexSet<_>>()
        .into_iter()
        .collect();
    files.sort_by(|a, b| locale_compare_units(a.units(), b.units()));
    let mut sites: Vec<_> = rows.into_iter().cloned().collect();
    sites.sort_by(|a, b| {
        locale_compare_units(a.file.units(), b.file.units())
            .then_with(|| {
                a.line
                    .partial_cmp(&b.line)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| locale_compare_units(a.binding.units(), b.binding.units()))
    });
    WorkerCensus {
        worker,
        files,
        bindings: counts,
        sites,
    }
}
pub fn deployable_census(
    deployables: &Deployables<'_>,
    rows: &[SiteRow],
) -> Option<DeployableCensus> {
    if deployables.kinds.is_empty() {
        return None;
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
    by_worker.sort_by(|a, _, b, _| locale_compare_units(a.units(), b.units()));
    Some(DeployableCensus {
        workers: by_worker
            .into_iter()
            .map(|(worker, rows)| worker_row(worker, rows))
            .collect(),
        unresolved_service_bindings: deployables.graph.unresolved,
    })
}
fn count(n: usize, noun: &str) -> JsString {
    format!("{n} {noun}{}", if n == 1 { "" } else { "s" }).into()
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
pub fn deployable_census_lines(census: &DeployableCensus) -> Vec<JsString> {
    let sites = census.workers.iter().map(|row| row.sites.len()).sum();
    let mut lines = vec![interpolate(&[
        "deployables: ".into(),
        count(census.workers.len(), "worker"),
        " using bindings, ".into(),
        count(sites, "site"),
        ", ".into(),
        count(census.unresolved_service_bindings, "service binding"),
        " to a worker with no config in the repo".into(),
    ])];
    lines.extend(census.workers.iter().map(|row| {
        let names = joined(
            object_keys(&row.bindings).into_iter().map(|name| {
                interpolate(&[name.clone(), format!(" {}", row.bindings[name]).into()])
            }),
            ", ",
        );
        interpolate(&[
            "  ".into(),
            row.worker.clone(),
            ": ".into(),
            count(row.sites.len(), "site"),
            " in ".into(),
            count(row.files.len(), "file"),
            " over ".into(),
            count(row.bindings.len(), "binding"),
            " (".into(),
            names,
            ")".into(),
        ])
    }));
    lines
}
