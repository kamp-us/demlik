use super::Libraries;
use crate::{
    project::{Collation, CollationError, CollationInput},
    render::text::number,
    text::{JsString, JsValue, object_keys},
};
use indexmap::{IndexMap, IndexSet};
use serde::{Serialize, Serializer};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCensus {
    #[serde(serialize_with = "serialize_types")]
    pub types: IndexMap<JsString, Vec<JsString>>,
    pub undeclared: Vec<JsString>,
    #[serde(serialize_with = "crate::text::serialize_number")]
    pub unjudged_imports: f64,
}
fn serialize_types<S: Serializer>(
    types: &IndexMap<JsString, Vec<JsString>>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    JsValue::Object(
        types
            .iter()
            .map(|(name, dirs)| {
                (
                    name.clone(),
                    JsValue::Array(dirs.iter().cloned().map(JsValue::String).collect()),
                )
            })
            .collect(),
    )
    .serialize(serializer)
}
pub struct MeasuredLibraries<'a> {
    pub scopes: &'a [JsString],
    pub undeclared: &'a [JsString],
    pub unjudged: f64,
}
pub fn library_census(
    libraries: &Libraries<'_>,
    measured: MeasuredLibraries<'_>,
    collation: &Collation,
) -> Result<Option<LibraryCensus>, CollationError> {
    let Some(rules) = libraries.rules() else {
        return Ok(None);
    };
    let scopes: IndexSet<_> = measured.scopes.iter().collect();
    let mut names = object_keys(&rules.library_types)
        .into_iter()
        .map(|name| CollationInput::from_utf16(name.units()).map(|input| (name, input)))
        .collect::<Result<Vec<_>, _>>()?;
    names.sort_by(|a, b| collation.compare(&a.1, &b.1));
    let mut types = IndexMap::new();
    for (name, _) in names {
        let mut dirs = libraries
            .dirs
            .iter()
            .filter(|dir| libraries.type_of_dir.get(*dir) == Some(&name))
            .map(|dir| JsString::from(dir.as_str()))
            .filter(|dir| scopes.contains(dir))
            .map(|dir| CollationInput::from_utf16(dir.units()).map(|input| (dir, input)))
            .collect::<Result<Vec<_>, _>>()?;
        dirs.sort_by(|a, b| collation.compare(&a.1, &b.1));
        types.insert(name.clone(), dirs.into_iter().map(|(dir, _)| dir).collect());
    }
    let mut undeclared = measured
        .undeclared
        .iter()
        .map(|name| CollationInput::from_utf16(name.units()).map(|input| (name.clone(), input)))
        .collect::<Result<Vec<_>, _>>()?;
    undeclared.sort_by(|a, b| collation.compare(&a.1, &b.1));
    Ok(Some(LibraryCensus {
        types,
        undeclared: undeclared.into_iter().map(|(name, _)| name).collect(),
        unjudged_imports: measured.unjudged,
    }))
}
fn join(parts: impl IntoIterator<Item = JsString>, separator: &str) -> JsString {
    let mut result = JsString::default();
    for (index, part) in parts.into_iter().enumerate() {
        if index > 0 {
            result.push_str(separator);
        }
        result.extend(&part);
    }
    result
}
pub fn census_lines(census: &LibraryCensus) -> Vec<JsString> {
    let names = object_keys(&census.types);
    let declared: usize = census.types.values().map(Vec::len).sum();
    let per_type = join(
        names.iter().map(|name| {
            let mut text = (*name).clone();
            text.push_str(&format!(" {}", number(census.types[*name].len() as f64)));
            text
        }),
        ", ",
    );
    let per_type = if per_type.is_empty() {
        "no type".into()
    } else {
        per_type
    };
    let mut first = JsString::from(format!("libraries: {} declared (", number(declared as f64)));
    first.extend(&per_type);
    first.push_str(&format!(
        "), {} undeclared, {} import{} left unjudged",
        number(census.undeclared.len() as f64),
        number(census.unjudged_imports),
        if census.unjudged_imports == 1.0 {
            ""
        } else {
            "s"
        }
    ));
    let mut lines = vec![first];
    for name in names {
        let dirs = &census.types[name];
        if dirs.is_empty() {
            continue;
        }
        let mut line = JsString::from("  ");
        line.extend(name);
        line.push_str(": ");
        line.extend(&join(dirs.iter().cloned(), ", "));
        lines.push(line);
    }
    if !census.undeclared.is_empty() {
        let mut line = JsString::from("  undeclared: ");
        line.extend(&join(census.undeclared.iter().cloned(), ", "));
        lines.push(line);
    }
    lines
}
