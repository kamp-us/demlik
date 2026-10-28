use super::glob::{GlobError, glob_to_regexp};
use super::rules::JsRegex;
use crate::project::{Collation, CollationError, CollationInput};
use crate::text::JsString;
use indexmap::{IndexMap, IndexSet};

#[derive(Debug)]
pub enum ConventionError {
    Pattern(GlobError),
    Collation(CollationError),
}
impl std::fmt::Display for ConventionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pattern(e) => e.fmt(f),
            Self::Collation(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for ConventionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(match self {
            Self::Pattern(e) => e,
            Self::Collation(e) => e,
        })
    }
}
impl From<GlobError> for ConventionError {
    fn from(error: GlobError) -> Self {
        Self::Pattern(error)
    }
}
impl From<CollationError> for ConventionError {
    fn from(error: CollationError) -> Self {
        Self::Collation(error)
    }
}

pub const DEFAULT_EXPORT: &str = "default";
#[derive(Debug, Clone)]
pub struct EntryExportConvention {
    pub files: JsString,
    pub exports: Vec<JsString>,
}
pub type EntryExportConventions = IndexMap<JsString, EntryExportConvention>;
pub struct CompiledConvention {
    pub name: JsString,
    pub files: JsRegex,
    pub exports: IndexSet<JsString>,
}
pub fn compile_conventions(
    conventions: &EntryExportConventions,
    collation: &Collation,
) -> Result<Vec<CompiledConvention>, ConventionError> {
    let mut names = conventions
        .keys()
        .map(|name| CollationInput::from_utf16(name.units()).map(|key| (name, key)))
        .collect::<Result<Vec<_>, _>>()?;
    names.sort_by(|a, b| collation.compare(&a.1, &b.1));
    names
        .into_iter()
        .map(|(name, _)| {
            Ok(CompiledConvention {
                name: name.clone(),
                files: glob_to_regexp(&conventions[name].files)?,
                exports: conventions[name].exports.iter().cloned().collect(),
            })
        })
        .collect()
}
pub fn matching_conventions(
    conventions: &[CompiledConvention],
    package_path: &JsString,
    export_names: &[JsString],
    collation: &Collation,
) -> Result<Vec<JsString>, CollationError> {
    let mut out = IndexSet::new();
    for convention in conventions {
        if convention.files.test(package_path)
            && export_names
                .iter()
                .any(|name| convention.exports.contains(name))
        {
            out.insert(convention.name.clone());
        }
    }
    let mut out = out
        .into_iter()
        .map(|value| CollationInput::from_utf16(value.units()).map(|key| (value, key)))
        .collect::<Result<Vec<_>, _>>()?;
    out.sort_by(|a, b| collation.compare(&a.1, &b.1));
    Ok(out.into_iter().map(|(value, _)| value).collect())
}
