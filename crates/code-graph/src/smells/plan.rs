use crate::extract::edges::distinct_external_callers;
use crate::project::locale_compare;
use crate::schema::{FunctionNode, PlanComponents, PlanRow};
use serde::Deserialize;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanAxis {
    Rot,
    Impact,
    Complexity,
    Size,
}
impl PlanAxis {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "rot" => Some(Self::Rot),
            "impact" => Some(Self::Impact),
            "complexity" => Some(Self::Complexity),
            "size" => Some(Self::Size),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rot => "rot",
            Self::Impact => "impact",
            Self::Complexity => "complexity",
            Self::Size => "size",
        }
    }
}
pub const PLAN_AXES: [PlanAxis; 4] = [
    PlanAxis::Rot,
    PlanAxis::Impact,
    PlanAxis::Complexity,
    PlanAxis::Size,
];
pub fn is_plan_axis(value: &str) -> bool {
    PlanAxis::parse(value).is_some()
}
fn primary(row: &PlanRow, axis: PlanAxis) -> [usize; 3] {
    let c = &row.components;
    let fan = c.fan_in.unwrap_or(0);
    match axis {
        PlanAxis::Rot => [c.smells, c.complexity, fan],
        PlanAxis::Impact => [fan, c.complexity, c.smells],
        PlanAxis::Complexity => [c.complexity, c.smells, fan],
        PlanAxis::Size => [row.loc, 0, 0],
    }
}

pub fn rank_plan(functions: &[FunctionNode], axis: PlanAxis) -> Vec<PlanRow> {
    let mut rows: Vec<_> = functions
        .iter()
        .map(|function| {
            let fan_in = function
                .edges
                .as_ref()
                .map(|edges| distinct_external_callers(&function.id, &edges.called_by));
            let smell_count = function.smells.len();
            let fan = fan_in.unwrap_or(0);
            let complexity = function.complexity;
            let score = match axis {
                PlanAxis::Rot => smell_count * 1000 + complexity * 10 + fan,
                PlanAxis::Impact => fan * 1000 + complexity * 10 + smell_count,
                PlanAxis::Complexity => complexity * 1000 + smell_count * 10 + fan,
                PlanAxis::Size => function.loc,
            };
            PlanRow {
                id: function.id.clone(),
                file: function.file.clone(),
                start_line: function.start_line,
                end_line: function.end_line,
                score,
                components: PlanComponents {
                    smells: smell_count,
                    complexity,
                    fan_in,
                },
                loc: function.loc,
                complexity,
                called_by_count: fan_in,
                smells: function.smells.clone(),
            }
        })
        .collect();
    rows.sort_by(|left, right| {
        primary(right, axis)
            .cmp(&primary(left, axis))
            .then_with(|| locale_compare(&left.file, &right.file))
            .then_with(|| left.start_line.cmp(&right.start_line))
            .then_with(|| locale_compare(&left.id, &right.id))
    });
    rows
}
