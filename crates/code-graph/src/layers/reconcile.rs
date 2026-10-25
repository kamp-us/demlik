use super::{
    analyze::{LayerEdge, LayerReport},
    rules::AllowedEdge,
};
use crate::{project::locale_compare_units, text::JsString};
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
pub fn reconcile<'a>(report: &'a LayerReport, allowed: &'a [AllowedEdge]) -> Reconciliation<'a> {
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
    let mut stale: Vec<_> = allowed
        .iter()
        .filter(|entry| !measured.contains_key(&edge_key(&entry.from, &entry.to)))
        .collect();
    undeclared.sort_by(|left, right| {
        locale_compare_units(left.from.units(), right.from.units())
            .then_with(|| left.from_line.cmp(&right.from_line))
    });
    miscounted.sort_by(|left, right| {
        locale_compare_units(
            edge_key(&left.declared.from, &left.declared.to).units(),
            edge_key(&right.declared.from, &right.declared.to).units(),
        )
    });
    stale.sort_by(|left, right| {
        locale_compare_units(
            edge_key(&left.from, &left.to).units(),
            edge_key(&right.from, &right.to).units(),
        )
    });
    Reconciliation {
        passed: undeclared.is_empty() && stale.is_empty() && miscounted.is_empty(),
        undeclared,
        stale,
        miscounted,
        allowed_sites,
    }
}
