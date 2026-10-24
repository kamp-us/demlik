use super::glob::{GlobError, glob_to_regexp};
use super::rules::JsRegex;
use crate::project::locale_compare_units;
use crate::text::JsString;
use indexmap::{IndexMap, IndexSet};

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
) -> Result<Vec<CompiledConvention>, GlobError> {
    let mut names: Vec<_> = conventions.keys().collect();
    names.sort_by(|left, right| locale_compare_units(left.units(), right.units()));
    names
        .into_iter()
        .map(|name| {
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
) -> Vec<JsString> {
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
    let mut out: Vec<_> = out.into_iter().collect();
    out.sort_by(|left, right| locale_compare_units(left.units(), right.units()));
    out
}
