use super::{
    ceilings::{CommentCeilings, is_governed_scope, js_round, to_points},
    census::{CommentCensus, governed_ratio},
};
use crate::{
    project::locale_compare,
    text::{JsString, has_object_prototype_property},
};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum CeilingDirection {
    Exceeded,
    Slack,
}
#[derive(Debug, Serialize)]
pub struct CeilingViolation {
    pub scope: String,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub measured: f64,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub ceiling: f64,
    pub direction: CeilingDirection,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub delta: f64,
    pub inherited: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RatchetVerdict {
    pub passed: bool,
    pub scopes_checked: usize,
    pub inherited_scopes: usize,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub default_ceiling: f64,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub slack_points: f64,
    pub violations: Vec<CeilingViolation>,
}
pub fn evaluate_ratchet(census: &CommentCensus, ceilings: &CommentCeilings) -> RatchetVerdict {
    let mut violations = Vec::new();
    let mut inherited_scopes = 0;
    let mut scopes_checked = 0;
    for row in &census.scopes {
        let scope = JsString::from(row.scope.as_str());
        if !is_governed_scope(&scope) {
            continue;
        }
        scopes_checked += 1;
        let recorded = ceilings.scopes.get(&scope);
        if recorded.is_none() && has_object_prototype_property(&scope) {
            continue;
        }
        let inherited = recorded.is_none();
        inherited_scopes += usize::from(inherited);
        let ceiling = recorded.copied().unwrap_or(ceilings.default);
        let measured = to_points(governed_ratio(row));
        let delta = js_round((measured - ceiling) * 10.0) / 10.0;
        let direction = if delta > 0.0 {
            Some(CeilingDirection::Exceeded)
        } else if !inherited && -delta > ceilings.slack_points {
            Some(CeilingDirection::Slack)
        } else {
            None
        };
        if let Some(direction) = direction {
            violations.push(CeilingViolation {
                scope: row.scope.clone(),
                measured,
                ceiling,
                direction,
                delta,
                inherited,
            });
        }
    }
    violations.sort_by(|left, right| {
        right
            .delta
            .abs()
            .partial_cmp(&left.delta.abs())
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| locale_compare(&left.scope, &right.scope))
    });
    RatchetVerdict {
        passed: violations.is_empty(),
        scopes_checked,
        inherited_scopes,
        default_ceiling: ceilings.default,
        slack_points: ceilings.slack_points,
        violations,
    }
}
