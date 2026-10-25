use super::{AllowedEdge, Layer, LayerRules};
use crate::{
    text::{JsObject, JsString, JsValue, object_keys},
    validation::{InputIssue, PathSegment},
};

type Path = Vec<PathSegment>;
fn field(path: &[PathSegment], name: &str) -> Path {
    let mut out = path.to_vec();
    out.push(PathSegment::Field(name.into()));
    out
}
fn indexed(path: &[PathSegment], index: usize) -> Path {
    let mut out = path.to_vec();
    out.push(PathSegment::Index(index));
    out
}
fn object<'a>(
    value: Option<&'a JsValue>,
    path: &[PathSegment],
) -> Result<&'a JsObject, InputIssue> {
    value
        .and_then(JsValue::as_object)
        .ok_or_else(|| InputIssue::invalid_type(path.to_vec(), "object", value))
}
fn get<'a>(object: &'a JsObject, key: &str) -> Option<&'a JsValue> {
    object.get(&JsString::from(key))
}
fn minimum(path: &[PathSegment], origin: &str, min: usize) -> InputIssue {
    let noun = if origin == "string" {
        "characters"
    } else {
        "items"
    };
    InputIssue::new(
        path.to_vec(),
        format!("Too small: expected {origin} to have >={min} {noun}"),
    )
    .with_details(JsObject::from([
        ("origin".into(), JsValue::String(origin.into())),
        ("code".into(), JsValue::String("too_small".into())),
        ("minimum".into(), JsValue::Number(min as f64)),
        ("inclusive".into(), JsValue::Bool(true)),
    ]))
}
fn text(value: Option<&JsValue>, path: &[PathSegment]) -> Result<JsString, InputIssue> {
    let Some(JsValue::String(value)) = value else {
        return Err(InputIssue::invalid_type(path.to_vec(), "string", value));
    };
    if value.is_empty() {
        return Err(minimum(path, "string", 1));
    }
    Ok(value.clone())
}
fn array<'a>(
    value: Option<&'a JsValue>,
    path: &[PathSegment],
) -> Result<&'a [JsValue], InputIssue> {
    match value {
        Some(JsValue::Array(values)) => Ok(values),
        _ => Err(InputIssue::invalid_type(path.to_vec(), "array", value)),
    }
}
fn strict(object: &JsObject, allowed: &[&str], path: &[PathSegment]) -> Result<(), InputIssue> {
    let unknown: Vec<_> = object_keys(object)
        .into_iter()
        .filter(|key| !allowed.iter().any(|name| *key == name))
        .collect();
    if unknown.is_empty() {
        return Ok(());
    }
    Err(InputIssue::unrecognized_keys(path.to_vec(), &unknown))
}
fn sites(value: Option<&JsValue>, path: &[PathSegment]) -> Result<u64, InputIssue> {
    let Some(JsValue::Number(number)) = value else {
        return Err(InputIssue::invalid_type(path.to_vec(), "number", value));
    };
    if !number.is_finite() {
        return Err(InputIssue::invalid_type(path.to_vec(), "number", value));
    }
    if number.fract() != 0.0 {
        let issue = InputIssue::invalid_type(path.to_vec(), "int", value);
        let mut details = issue.details().clone();
        details.insert("format".into(), JsValue::String("safeint".into()));
        return Err(issue.with_details(details));
    }
    const SAFE: f64 = 9_007_199_254_740_991.0;
    if number.abs() > SAFE {
        let (code, limit, message) = if *number > SAFE {
            (
                "too_big",
                "maximum",
                "Too big: expected int to be <9007199254740991",
            )
        } else {
            (
                "too_small",
                "minimum",
                "Too small: expected int to be >-9007199254740991",
            )
        };
        return Err(
            InputIssue::new(path.to_vec(), message).with_details(JsObject::from([
                ("code".into(), JsValue::String(code.into())),
                (limit.into(), JsValue::Number(SAFE.copysign(*number))),
                (
                    "note".into(),
                    JsValue::String("Integers must be within the safe integer range.".into()),
                ),
                ("origin".into(), JsValue::String("int".into())),
            ])),
        );
    }
    if *number <= 0.0 {
        return Err(
            InputIssue::new(path.to_vec(), "Too small: expected number to be >0").with_details(
                JsObject::from([
                    ("origin".into(), JsValue::String("number".into())),
                    ("code".into(), JsValue::String("too_small".into())),
                    ("minimum".into(), JsValue::Number(0.0)),
                    ("inclusive".into(), JsValue::Bool(false)),
                ]),
            ),
        );
    }
    Ok(*number as u64)
}
pub(super) fn layer(value: &JsValue, path: &[PathSegment]) -> Result<Layer, InputIssue> {
    let object = object(Some(value), path)?;
    let name = text(get(object, "name"), &field(path, "name"))?;
    let paths_at = field(path, "paths");
    let values = array(get(object, "paths"), &paths_at)?;
    let paths = values
        .iter()
        .enumerate()
        .map(|(index, value)| text(Some(value), &indexed(&paths_at, index)))
        .collect::<Result<Vec<_>, _>>()?;
    if paths.is_empty() {
        return Err(minimum(&paths_at, "array", 1));
    }
    strict(object, &["name", "paths"], path)?;
    Ok(Layer { name, paths })
}
pub(super) fn allowed_edge(
    value: &JsValue,
    path: &[PathSegment],
) -> Result<AllowedEdge, InputIssue> {
    let object = object(Some(value), path)?;
    let from = text(get(object, "from"), &field(path, "from"))?;
    let to = text(get(object, "to"), &field(path, "to"))?;
    let sites = sites(get(object, "sites"), &field(path, "sites"))?;
    let reason = text(get(object, "reason"), &field(path, "reason"))?;
    strict(object, &["from", "to", "sites", "reason"], path)?;
    Ok(AllowedEdge {
        from,
        to,
        sites,
        reason,
    })
}
pub(super) fn rules(value: &JsValue) -> Result<LayerRules, InputIssue> {
    let object = object(Some(value), &[])?;
    let layers = match get(object, "layers") {
        None => Vec::new(),
        Some(value) => {
            let at = field(&[], "layers");
            let values = array(Some(value), &at)?;
            let parsed = values
                .iter()
                .enumerate()
                .map(|(index, value)| layer(value, &indexed(&at, index)))
                .collect::<Result<Vec<_>, _>>()?;
            if parsed.len() < 2 {
                return Err(minimum(&at, "array", 2));
            }
            parsed
        }
    };
    let allowed = match get(object, "allowed") {
        None => Vec::new(),
        Some(value) => {
            let at = field(&[], "allowed");
            array(Some(value), &at)?
                .iter()
                .enumerate()
                .map(|(index, value)| allowed_edge(value, &indexed(&at, index)))
                .collect::<Result<Vec<_>, _>>()?
        }
    };
    strict(object, &["layers", "allowed"], &[])?;
    Ok(LayerRules { layers, allowed })
}
