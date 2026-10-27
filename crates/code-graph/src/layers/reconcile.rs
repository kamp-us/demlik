use super::{
    analyze::{LayerEdge, LayerReport},
    rules::AllowedEdge,
};
use crate::{
    project::{Collation, CollationError, CollationInput},
    text::JsString,
};
use indexmap::IndexMap;
use serde::Serialize;

pub fn edge_key(from: &JsString, to: &JsString) -> JsString {
    let mut out = from.clone();
    out.push_str(" ");
    out.extend(to);
    out
}
#[derive(Debug, Serialize)]
pub struct MiscountedEdge<'a> {
    pub declared: &'a AllowedEdge,
    pub actual: usize,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reconciliation<'a> {
    pub passed: bool,
    pub undeclared: Vec<&'a LayerEdge>,
    pub stale: Vec<&'a AllowedEdge>,
    pub miscounted: Vec<MiscountedEdge<'a>>,
    pub allowed_sites: usize,
}
pub fn reconcile<'a>(
    report: &'a LayerReport,
    allowed: &'a [AllowedEdge],
    collation: &Collation,
) -> Result<Reconciliation<'a>, CollationError> {
    let mut measured: IndexMap<JsString, Vec<&LayerEdge>> = IndexMap::new();
    for edge in &report.violations {
        measured
            .entry(edge_key(&edge.from, &edge.to))
            .or_default()
            .push(edge);
    }
    let declared: IndexMap<_, _> = allowed
        .iter()
        .map(|edge| (edge_key(&edge.from, &edge.to), edge))
        .collect();
    let mut undeclared: Vec<&LayerEdge> = Vec::new();
    let mut miscounted = Vec::new();
    let mut allowed_sites = 0;
    for (key, edges) in &measured {
        let Some(&entry) = declared.get(key) else {
            undeclared.extend(edges.iter().copied());
            continue;
        };
        if entry.sites != edges.len() as u64 {
            miscounted.push(MiscountedEdge {
                declared: entry,
                actual: edges.len(),
            });
        } else {
            allowed_sites += edges.len();
        }
    }
    let stale: Vec<_> = allowed
        .iter()
        .filter(|entry| !measured.contains_key(&edge_key(&entry.from, &entry.to)))
        .collect();
    let mut undeclared = undeclared
        .into_iter()
        .map(|edge| CollationInput::from_utf16(edge.from.units()).map(|input| (edge, input)))
        .collect::<Result<Vec<_>, _>>()?;
    let mut miscounted = miscounted
        .into_iter()
        .map(|edge| {
            CollationInput::from_utf16(edge_key(&edge.declared.from, &edge.declared.to).units())
                .map(|input| (edge, input))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut stale = stale
        .into_iter()
        .map(|edge| {
            CollationInput::from_utf16(edge_key(&edge.from, &edge.to).units())
                .map(|input| (edge, input))
        })
        .collect::<Result<Vec<_>, _>>()?;
    undeclared.sort_by(|a, b| {
        collation
            .compare(&a.1, &b.1)
            .then_with(|| a.0.from_line.cmp(&b.0.from_line))
    });
    miscounted.sort_by(|a, b| collation.compare(&a.1, &b.1));
    stale.sort_by(|a, b| collation.compare(&a.1, &b.1));
    Ok(Reconciliation {
        passed: undeclared.is_empty() && stale.is_empty() && miscounted.is_empty(),
        undeclared: undeclared.into_iter().map(|(edge, _)| edge).collect(),
        stale: stale.into_iter().map(|(edge, _)| edge).collect(),
        miscounted: miscounted.into_iter().map(|(edge, _)| edge).collect(),
        allowed_sites,
    })
}
