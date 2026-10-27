use super::{settings::CollapseSettings, tokens::name_tokens};
use crate::{
    number::js_round, project::locale_compare, render::text::number, schema::FunctionNode,
    text::JsString,
};
use indexmap::IndexSet;
use serde::Serialize;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SignalName {
    Shape,
    Callees,
    Callers,
    Name,
}
#[derive(Debug, Serialize)]
pub struct Signal {
    pub signal: SignalName,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub strength: f64,
    pub detail: JsString,
}
pub(super) struct Twin<'g> {
    pub function: &'g FunctionNode,
    pub callees: IndexSet<&'g JsString>,
    pub callers: IndexSet<&'g str>,
    pub tokens: IndexSet<String>,
}
impl<'g> Twin<'g> {
    pub fn new(function: &'g FunctionNode) -> Self {
        Self {
            function,
            callees: function
                .edges
                .iter()
                .flat_map(|e| &e.calls)
                .map(|c| &c.callee_id)
                .collect(),
            callers: function
                .edges
                .iter()
                .flat_map(|e| &e.called_by)
                .map(|c| c.caller_id.as_str())
                .collect(),
            tokens: name_tokens(&function.name),
        }
    }
}
pub(super) fn round4(n: f64) -> f64 {
    js_round(n * 10000.0) / 10000.0
}
fn jaccard<T: Eq + std::hash::Hash>(a: &IndexSet<T>, b: &IndexSet<T>) -> f64 {
    let shared = a.iter().filter(|v| b.contains(*v)).count();
    let union = a.len() + b.len() - shared;
    if union == 0 {
        0.0
    } else {
        shared as f64 / union as f64
    }
}
fn shape(a: &Twin<'_>, b: &Twin<'_>, s: &CollapseSettings) -> Option<Signal> {
    let (a, b) = (a.function, b.function);
    let tolerance = s
        .shape_loc_slack
        .max(js_round(s.shape_loc_ratio * (a.loc.max(b.loc) as f64)));
    let loc = (a.loc as f64 - b.loc as f64).abs();
    let cx = (a.complexity as f64 - b.complexity as f64).abs();
    let nest = (a.nesting_depth as f64 - b.nesting_depth as f64).abs();
    if loc > tolerance || cx > s.shape_complexity_slack || nest > s.shape_nesting_slack {
        return None;
    }
    let closeness = |delta: f64, tolerance: f64| 1.0 - delta / (tolerance + 1.0);
    Some(Signal {
        signal: SignalName::Shape,
        strength: round4(
            (closeness(loc, tolerance)
                + closeness(cx, s.shape_complexity_slack)
                + closeness(nest, s.shape_nesting_slack))
                / 3.0,
        ),
        detail: format!(
            "loc {}/{} cx {}/{} nest {}/{}",
            number(a.loc as f64),
            number(b.loc as f64),
            number(a.complexity as f64),
            number(b.complexity as f64),
            number(a.nesting_depth as f64),
            number(b.nesting_depth as f64)
        )
        .into(),
    })
}
fn set_signal<T: Eq + std::hash::Hash>(
    a: &IndexSet<T>,
    b: &IndexSet<T>,
    s: &CollapseSettings,
    threshold: f64,
    signal: SignalName,
    label: &str,
) -> Option<Signal> {
    if (a.len() as f64) < s.min_set_size || (b.len() as f64) < s.min_set_size {
        return None;
    }
    let score = jaccard(a, b);
    if score < threshold {
        return None;
    }
    Some(Signal {
        signal,
        strength: round4(score),
        detail: format!(
            "jaccard {} over {}/{} {label}",
            number(round4(score)),
            a.len(),
            b.len()
        )
        .into(),
    })
}
fn name(a: &Twin<'_>, b: &Twin<'_>, s: &CollapseSettings) -> Option<Signal> {
    let smaller = a.tokens.len().min(b.tokens.len());
    if smaller == 0 {
        return None;
    }
    let mut shared: Vec<_> = a
        .tokens
        .iter()
        .filter(|t| b.tokens.contains(*t))
        .map(String::as_str)
        .collect();
    shared.sort_by(|a, b| locale_compare(a, b));
    if !shared
        .iter()
        .any(|t| (t.len() as f64) >= s.name_min_token_length)
    {
        return None;
    }
    let score = shared.len() as f64 / smaller as f64;
    if score < s.name_overlap {
        return None;
    }
    Some(Signal {
        signal: SignalName::Name,
        strength: round4(score),
        detail: format!("shared {{{}}}", shared.join(",")).into(),
    })
}
pub(super) fn fired_signals(a: &Twin<'_>, b: &Twin<'_>, s: &CollapseSettings) -> Vec<Signal> {
    [
        shape(a, b, s),
        set_signal(
            &a.callees,
            &b.callees,
            s,
            s.callee_jaccard,
            SignalName::Callees,
            "callees",
        ),
        set_signal(
            &a.callers,
            &b.callers,
            s,
            s.caller_jaccard,
            SignalName::Callers,
            "callers",
        ),
        name(a, b, s),
    ]
    .into_iter()
    .flatten()
    .collect()
}
