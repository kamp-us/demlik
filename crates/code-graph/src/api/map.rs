pub use super::input::{
    ApiArgumentError, ApiArgumentLocation, ApiError, ApiInputError, ApiSchemaError, issue_text,
};
use super::input::{nonempty_string, record_key, refusal, unknown_keys};
use crate::{
    project::{relative_path_text_from, resolve_path_text_from},
    text::{JsRegex, JsString, JsValue, object_keys},
    validation::{InputIssue, PathSegment, record_object},
};
use indexmap::IndexMap;
use serde::Serialize;
use std::{fs, sync::LazyLock};

#[derive(Debug, Serialize)]
pub struct ApiMapEntry {
    pub entry: JsString,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<JsString>,
}
#[derive(Debug, Serialize)]
#[serde(transparent)]
pub struct ApiMap {
    #[serde(serialize_with = "super::model::serialize_record")]
    pub entries: IndexMap<JsString, ApiMapEntry>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiSubpath {
    pub subpath: JsString,
    pub entry: JsString,
    pub entry_absolute: JsString,
    pub tier: Option<JsString>,
}

pub fn parse_api_map(value: &JsValue) -> Result<ApiMap, ApiSchemaError> {
    parse_map(value, true)
}
fn parse_map(value: &JsValue, nonempty: bool) -> Result<ApiMap, ApiSchemaError> {
    let Some(record) = record_object(value).map_err(ApiSchemaError::TypeError)? else {
        return Err(ApiSchemaError::Issues(vec![InputIssue::invalid_type(
            vec![],
            "record",
            Some(value),
        )]));
    };
    let mut issues = Vec::new();
    let mut map = IndexMap::new();
    for key in object_keys(record) {
        if key == "__proto__"
            || !record_key(
                key,
                vec![PathSegment::Field(key.clone())],
                "a subpath must be non-empty",
                &mut issues,
            )
        {
            continue;
        }
        let path = vec![PathSegment::Field(key.clone())];
        let Some(entry) = record[key].as_object() else {
            issues.push(InputIssue::invalid_type(path, "object", Some(&record[key])));
            continue;
        };
        let text = nonempty_string(
            entry.get(&JsString::from("entry")),
            vec![
                PathSegment::Field(key.clone()),
                PathSegment::Field("entry".into()),
            ],
            "entry must be a non-empty path",
            &mut issues,
        );
        let tier = entry.get(&JsString::from("tier")).and_then(|value| {
            nonempty_string(
                Some(value),
                vec![
                    PathSegment::Field(key.clone()),
                    PathSegment::Field("tier".into()),
                ],
                "tier must be a non-empty string",
                &mut issues,
            )
        });
        unknown_keys(entry, &["entry", "tier"], path, &mut issues);
        if let Some(text) = text {
            map.insert(key.clone(), ApiMapEntry { entry: text, tier });
        }
    }
    if nonempty && record.keys().all(|key| key == "__proto__") {
        issues.push(
            InputIssue::new(vec![], "the API map names no subpath").with_details(
                crate::text::JsObject::from([("code".into(), JsValue::String("custom".into()))]),
            ),
        );
    }
    if issues.is_empty() {
        Ok(ApiMap { entries: map })
    } else {
        Err(ApiSchemaError::Issues(issues))
    }
}
static SOURCE_EXTENSION: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(&r"\.(?:ts|tsx|mts|cts)$".into()).expect("static source extension regex is valid")
});
static DECLARATION_FILE: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new(&r"\.d\.(?:ts|mts|cts)$".into()).expect("static declaration regex is valid")
});
struct MapSide<'a> {
    map: &'static str,
    root: &'a JsString,
    tree: &'a JsString,
}
fn message(side: &MapSide<'_>, subpath: &JsString, entry: &JsString) -> JsString {
    let mut out = JsString::from(side.map);
    out.push_str(": ");
    out.extend(subpath);
    out.push_str(": entry ");
    out.extend(entry);
    out
}
fn checked_subpath(
    root: &JsString,
    subpath: &JsString,
    entry: &JsString,
    side: &MapSide<'_>,
) -> Result<JsString, ApiError> {
    let absolute = resolve_path_text_from(root, entry).map_err(|source| ApiError::Io {
        path: entry.clone(),
        source,
    })?;
    let relative = relative_path_text_from(root, &absolute).map_err(|source| ApiError::Io {
        path: absolute.clone(),
        source,
    })?;
    if relative.starts_with("..") || relative.starts_with("/") {
        let mut out = message(side, subpath, entry);
        out.push_str(" lies outside ");
        out.extend(side.root);
        return Err(ApiError::Input(ApiInputError::new(out)));
    }
    if !SOURCE_EXTENSION.test(entry) || DECLARATION_FILE.test(entry) {
        let mut out = message(side, subpath, entry);
        out.push_str(" is not a .ts, .tsx, .mts or .cts source file");
        return Err(ApiError::Input(ApiInputError::new(out)));
    }
    let file = absolute.to_lossy();
    let exists = std::path::Path::new(&file).exists();
    if !exists
        || !fs::metadata(&file)
            .map_err(|source| ApiError::Io {
                path: absolute.clone(),
                source,
            })?
            .is_file()
    {
        let mut out = message(side, subpath, entry);
        out.push_str(" does not exist");
        out.extend(side.tree);
        return Err(ApiError::Input(ApiInputError::new(out)));
    }
    Ok(absolute)
}
fn checked_subpaths(
    root: &JsString,
    map: ApiMap,
    side: MapSide<'_>,
) -> Result<Vec<ApiSubpath>, ApiError> {
    let mut map = map.entries.into_iter().collect::<Vec<_>>();
    map.sort_by(|(left, _), (right, _)| left.cmp(right));
    map.into_iter()
        .map(|(subpath, value)| {
            let entry_absolute = checked_subpath(root, &subpath, &value.entry, &side)?;
            Ok(ApiSubpath {
                subpath,
                entry: value.entry,
                entry_absolute,
                tier: value.tier,
            })
        })
        .collect()
}
pub fn api_subpaths(root_absolute: &JsString, map: &JsValue) -> Result<Vec<ApiSubpath>, ApiError> {
    let map = parse_api_map(map).map_err(|error| refusal("invalid API map: ", error))?;
    checked_subpaths(
        root_absolute,
        map,
        MapSide {
            map: "API map",
            root: root_absolute,
            tree: &JsString::default(),
        },
    )
}
pub fn base_api_subpaths(
    base_root: &JsString,
    map: &JsValue,
    sha: &JsString,
) -> Result<Vec<ApiSubpath>, ApiError> {
    let map = parse_map(map, false).map_err(|error| refusal("invalid base API map: ", error))?;
    let mut at = JsString::from("at the base ");
    at.extend(&JsString::from_units(
        sha.units()[..sha.units().len().min(12)].to_vec(),
    ));
    let mut named_root = JsString::from("the package root ");
    named_root.extend(&at);
    let mut tree = JsString::from(" ");
    tree.extend(&at);
    checked_subpaths(
        base_root,
        map,
        MapSide {
            map: "base API map",
            root: &named_root,
            tree: &tree,
        },
    )
}
