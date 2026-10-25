use crate::{
    api::{
        input::{nonempty_string, record_key, refusal, unknown_keys},
        map::{ApiError, ApiSchemaError},
        model::{BUMPS, Bump, BumpPolicy, BumpRule, TierRow},
    },
    text::{JsObject, JsString, JsValue, object_keys},
    validation::{InputIssue, PathSegment, record_object},
};
use indexmap::IndexMap;
use std::sync::Arc;

fn rule(
    value: Option<&JsValue>,
    path: Vec<PathSegment>,
    issues: &mut Vec<InputIssue>,
) -> Option<Arc<BumpRule>> {
    let Some(JsValue::Object(object)) = value else {
        issues.push(InputIssue::invalid_type(path, "object", value));
        return None;
    };
    let bump = BUMPS.into_iter().find(|bump| {
        object
            .get(&JsString::from("bump"))
            .and_then(JsValue::as_string)
            .is_some_and(|value| value == bump.as_str())
    });
    if bump.is_none() {
        let mut at = path.clone();
        at.push(PathSegment::Field("bump".into()));
        issues.push(
            InputIssue::new(
                at,
                "Invalid option: expected one of \"none\"|\"patch\"|\"minor\"|\"major\"",
            )
            .with_details(JsObject::from([
                ("code".into(), JsValue::String("invalid_value".into())),
                (
                    "values".into(),
                    JsValue::Array(
                        BUMPS
                            .iter()
                            .map(|bump| JsValue::String(bump.as_str().into()))
                            .collect(),
                    ),
                ),
            ])),
        );
    }
    let callout = match object.get(&JsString::from("callout")) {
        None => false,
        Some(JsValue::Bool(value)) => *value,
        value => {
            let mut at = path.clone();
            at.push(PathSegment::Field("callout".into()));
            issues.push(InputIssue::invalid_type(at, "boolean", value));
            false
        }
    };
    unknown_keys(object, &["bump", "callout"], path, issues);
    bump.map(|bump| Arc::new(BumpRule { bump, callout }))
}
fn row(
    value: Option<&JsValue>,
    path: Vec<PathSegment>,
    issues: &mut Vec<InputIssue>,
) -> Option<TierRow> {
    let Some(JsValue::Object(object)) = value else {
        issues.push(InputIssue::invalid_type(path, "object", value));
        return None;
    };
    let mut child = |key: &str| {
        let mut at = path.clone();
        at.push(PathSegment::Field(key.into()));
        rule(object.get(&JsString::from(key)), at, issues)
    };
    let added = child("added");
    let changed = child("changed");
    let removed = child("removed");
    unknown_keys(object, &["added", "changed", "removed"], path, issues);
    Some(TierRow {
        added: added?,
        changed: changed?,
        removed: removed?,
    })
}
impl BumpPolicy {
    pub fn parse(value: &JsValue) -> Result<Self, ApiSchemaError> {
        let Some(object) = value.as_object() else {
            return Err(ApiSchemaError::Issues(vec![InputIssue::invalid_type(
                vec![],
                "object",
                Some(value),
            )]));
        };
        // A record's constructor failure is thrown while the schema runs, even if
        // an earlier field also collected an ordinary issue.
        let record = object
            .get(&JsString::from("tiers"))
            .map(record_object)
            .transpose()
            .map_err(ApiSchemaError::TypeError)?;
        let mut issues = Vec::new();
        let callout = nonempty_string(
            object.get(&JsString::from("callout")),
            vec![PathSegment::Field("callout".into())],
            "the callout marker must be non-empty",
            &mut issues,
        );
        let mut tiers = IndexMap::new();
        match record {
            Some(Some(record)) => {
                for key in object_keys(record) {
                    let path = vec![
                        PathSegment::Field("tiers".into()),
                        PathSegment::Field(key.clone()),
                    ];
                    if key != "__proto__"
                        && record_key(key, path.clone(), "a tier must be non-empty", &mut issues)
                        && let Some(row) = row(Some(&record[key]), path, &mut issues)
                    {
                        tiers.insert(key.clone(), row);
                    }
                }
            }
            _ => issues.push(InputIssue::invalid_type(
                vec![PathSegment::Field("tiers".into())],
                "record",
                object.get(&JsString::from("tiers")),
            )),
        }
        let default = object.get(&JsString::from("default")).and_then(|value| {
            row(
                Some(value),
                vec![PathSegment::Field("default".into())],
                &mut issues,
            )
        });
        unknown_keys(
            object,
            &["callout", "tiers", "default"],
            vec![],
            &mut issues,
        );
        if issues.is_empty() {
            Ok(Self {
                callout: callout.expect("valid policy has a callout"),
                tiers,
                default,
            })
        } else {
            Err(ApiSchemaError::Issues(issues))
        }
    }
}
pub fn bump_policy(value: &JsValue) -> Result<BumpPolicy, ApiError> {
    BumpPolicy::parse(value).map_err(|error| refusal("invalid bump policy: ", error))
}
pub fn bump_rank(bump: Bump) -> usize {
    bump.rank()
}
