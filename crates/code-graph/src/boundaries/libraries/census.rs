use super::Libraries;
use crate::{
    project::locale_compare_units,
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
) -> Option<LibraryCensus> {
    let rules = libraries.rules()?;
    let scopes: IndexSet<_> = measured.scopes.iter().collect();
    let mut names = object_keys(&rules.library_types);
    names.sort_by(|a, b| locale_compare_units(a.units(), b.units()));
    let types = names
        .into_iter()
        .map(|name| {
            let mut dirs: Vec<JsString> = libraries
                .dirs
                .iter()
                .filter(|dir| libraries.type_of_dir.get(*dir) == Some(&name))
                .map(|dir| dir.as_str().into())
                .filter(|dir| scopes.contains(dir))
                .collect();
            dirs.sort_by(|a, b| locale_compare_units(a.units(), b.units()));
            (name.clone(), dirs)
        })
        .collect();
    let mut undeclared = measured.undeclared.to_vec();
    undeclared.sort_by(|a, b| locale_compare_units(a.units(), b.units()));
    Some(LibraryCensus {
        types,
        undeclared,
        unjudged_imports: measured.unjudged,
    })
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
