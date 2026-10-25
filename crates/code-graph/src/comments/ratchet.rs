use super::{
    ceilings::{CommentCeilings, is_governed_scope, js_round, to_points},
    census::{CommentCensus, governed_ratio},
};
use crate::{
    project::locale_compare_units,
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
    pub scope: JsString,
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
                scope: row.scope.as_str().into(),
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
            .then_with(|| locale_compare_units(left.scope.units(), right.scope.units()))
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RatchetRender {
    pub stdout: JsString,
    pub exit_code: u8,
}
pub fn render_ratchet(
    verdict: &RatchetVerdict,
    json: bool,
    pretty: bool,
) -> Result<RatchetRender, serde_json::Error> {
    use crate::render::{
        json::stable_stringify,
        text::{fixed, join, number, pad_end, pad_end_units, pad_start},
    };
    let exit_code = u8::from(!verdict.passed);
    if json {
        return Ok(RatchetRender {
            stdout: stable_stringify(verdict, pretty)?.into(),
            exit_code,
        });
    }
    let pts = |value| format!("{}%", fixed(value, 1));
    if verdict.passed {
        return Ok(RatchetRender {
            stdout: format!(
                "comment ratchet: PASS — {} scope(s) within ceiling ({} on the {} default, slack {} pts).",
                verdict.scopes_checked,
                verdict.inherited_scopes,
                pts(verdict.default_ceiling),
                number(verdict.slack_points)
            ).into(),
            exit_code,
        });
    }
    let mut lines: Vec<JsString> = vec![
        format!(
            "COMMENT RATCHET FAILED — {} of {} scope(s) off their ceiling.",
            verdict.violations.len(),
            verdict.scopes_checked
        )
        .into(),
        format!(
            "  {}{}{}  {}{}",
            pad_end("scope", 46),
            pad_start("measured", 8),
            pad_start("ceiling", 9),
            pad_end("direction", 9),
            pad_start("delta", 7)
        )
        .into(),
    ];
    for violation in &verdict.violations {
        let sign = if violation.delta > 0.0 { "+" } else { "" };
        let tag = if violation.inherited {
            "  (default)"
        } else {
            ""
        };
        let direction = match violation.direction {
            CeilingDirection::Exceeded => "EXCEEDED",
            CeilingDirection::Slack => "SLACK",
        };
        let mut line = JsString::from("  ");
        line.extend(&pad_end_units(&violation.scope, 46));
        line.push_str(&format!(
            "{}{}  {}{} pts{tag}",
            pad_start(&pts(violation.measured), 8),
            pad_start(&pts(violation.ceiling), 9),
            pad_end(direction, 9),
            pad_start(&format!("{sign}{}", fixed(violation.delta, 1)), 7)
        ));
        lines.push(line);
    }
    if verdict
        .violations
        .iter()
        .any(|violation| violation.direction == CeilingDirection::Exceeded)
    {
        lines.push(
            "  EXCEEDED: comment volume grew past what this scope recorded. Cut it back, or".into(),
        );
        lines.push(
            format!(
                "  raise the entry in {} and say why in the PR body.",
                super::ceilings::CEILINGS_FILENAME
            )
            .into(),
        );
    }
    if verdict
        .violations
        .iter()
        .any(|violation| violation.direction == CeilingDirection::Slack)
    {
        lines.push(
            format!(
                "  SLACK: the ceiling sits more than {} pts above reality, so it is no",
                number(verdict.slack_points)
            )
            .into(),
        );
        lines.push(
            "  longer a ceiling. Re-record: `pnpm code-graph . --comments --write-ceilings`."
                .into(),
        );
    }
    Ok(RatchetRender {
        stdout: join(lines, "\n"),
        exit_code,
    })
}
