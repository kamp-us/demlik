use super::census::{CommentCensus, governed_ratio};
use crate::{
    text::{JsObject, JsRegex, JsString, JsValue, object_keys},
    validation::{InputIssue, PathSegment, RecordTypeError, record_object},
};
use indexmap::IndexMap;
use serde::{Serialize, Serializer};
use std::sync::LazyLock;

pub const CEILINGS_FILENAME: &str = "comment-ceilings.json";
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentCeilings {
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub default: f64,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub slack_points: f64,
    #[serde(serialize_with = "serialize_scopes")]
    pub scopes: IndexMap<JsString, f64>,
}
fn serialize_scopes<S: Serializer>(
    scopes: &IndexMap<JsString, f64>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    crate::text::serialize_object(
        &scopes
            .iter()
            .map(|(key, value)| (key.clone(), JsValue::Number(*value)))
            .collect(),
        serializer,
    )
}
impl Default for CommentCeilings {
    fn default() -> Self {
        Self {
            default: 40.0,
            slack_points: 2.0,
            scopes: IndexMap::new(),
        }
    }
}
#[derive(Debug)]
pub enum CeilingInputError {
    Issue(InputIssue),
    TypeError(RecordTypeError),
}
impl std::fmt::Display for CeilingInputError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Issue(issue) => issue.fmt(formatter),
            Self::TypeError(error) => error.fmt(formatter),
        }
    }
}
impl std::error::Error for CeilingInputError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Issue(issue) => issue,
            Self::TypeError(error) => error,
        })
    }
}
fn invalid(expected: &str, value: &JsValue, path: Vec<PathSegment>) -> CeilingInputError {
    CeilingInputError::Issue(InputIssue::invalid_type(path, expected, Some(value)))
}
fn number(value: &JsValue, path: Vec<PathSegment>) -> Result<f64, CeilingInputError> {
    let JsValue::Number(number) = value else {
        return Err(invalid("number", value, path));
    };
    if !number.is_finite() {
        return Err(invalid("number", value, path));
    }
    if *number < 0.0 {
        return Err(CeilingInputError::Issue(
            InputIssue::new(path, "Too small: expected number to be >=0").with_details(
                JsObject::from([
                    ("origin".into(), JsValue::String("number".into())),
                    ("code".into(), JsValue::String("too_small".into())),
                    ("minimum".into(), JsValue::Number(0.0)),
                    ("inclusive".into(), JsValue::Bool(true)),
                ]),
            ),
        ));
    }
    Ok(*number)
}
fn field(key: &str) -> Vec<PathSegment> {
    vec![PathSegment::Field(key.into())]
}
impl CommentCeilings {
    pub fn parse(value: &JsValue) -> Result<Self, CeilingInputError> {
        let Some(object) = value.as_object() else {
            return Err(invalid("object", value, Vec::new()));
        };
        let record = object
            .get(&JsString::from("scopes"))
            .map(record_object)
            .transpose()
            .map_err(CeilingInputError::TypeError)?;
        let defaults = Self::default();
        let default = object
            .get(&JsString::from("default"))
            .map(|value| number(value, field("default")))
            .transpose()?
            .unwrap_or(defaults.default);
        let slack_points = object
            .get(&JsString::from("slackPoints"))
            .map(|value| number(value, field("slackPoints")))
            .transpose()?
            .unwrap_or(defaults.slack_points);
        let mut scopes = IndexMap::new();
        if let Some(record) = record {
            let Some(record) = record else {
                return Err(invalid(
                    "record",
                    &object[&JsString::from("scopes")],
                    field("scopes"),
                ));
            };
            for key in object_keys(record) {
                if key != "__proto__" {
                    scopes.insert(
                        key.clone(),
                        number(
                            &record[key],
                            vec![
                                PathSegment::Field("scopes".into()),
                                PathSegment::Field(key.clone()),
                            ],
                        )?,
                    );
                }
            }
        }
        let unknown = object_keys(object)
            .into_iter()
            .filter(|key| {
                !matches!(
                    key.to_utf8().as_deref(),
                    Ok("default" | "slackPoints" | "scopes")
                )
            })
            .collect::<Vec<_>>();
        if !unknown.is_empty() {
            return Err(CeilingInputError::Issue(InputIssue::unrecognized_keys(
                Vec::new(),
                &unknown,
            )));
        }
        Ok(Self {
            default,
            slack_points,
            scopes,
        })
    }
}
pub(crate) fn js_round(value: f64) -> f64 {
    if !value.is_finite() || value == 0.0 {
        return value;
    }
    let lower = value.floor();
    let rounded = if value - lower < 0.5 {
        lower
    } else {
        lower + 1.0
    };
    if rounded == 0.0 {
        0.0f64.copysign(value)
    } else {
        rounded
    }
}
pub fn to_points(ratio: f64) -> f64 {
    js_round(ratio * 1000.0) / 10.0
}
pub fn ceiling_points(ratio: f64) -> f64 {
    (js_round(ratio * 10000.0) / 10.0).ceil() / 10.0
}
static UNGOVERNED: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(&r"(^|/)(fixtures|__fixtures__|opensrc)(/|$)".into())
        .expect("static governed-scope pattern is valid ECMAScript")
});
pub fn is_governed_scope(scope: &JsString) -> bool {
    !UNGOVERNED.test(scope)
}
pub fn ceilings_from_census(census: &CommentCensus, base: &CommentCeilings) -> CommentCeilings {
    let mut scopes = IndexMap::new();
    for row in &census.scopes {
        let scope = JsString::from(row.scope.as_str());
        if is_governed_scope(&scope) && scope != "__proto__" {
            scopes.insert(scope, ceiling_points(governed_ratio(row)));
        }
    }
    CommentCeilings {
        default: base.default,
        slack_points: base.slack_points,
        scopes,
    }
}
