use super::entry_file::first_offending_form;
use crate::{
    boundaries::{
        deployables::BindingSite,
        rules::{BoundaryRules, ShapeKind, declares_read_allowance},
        zones::reads::{ReadAllowance, first_write, read_allowance_of},
    },
    extract::wrangler_config::BindingCatalog,
    kinds::glob::{GlobError, glob_to_regexp},
    syntax::file::SyntaxFile,
    text::{JsRegex, JsString},
};
use indexmap::IndexSet;
use serde::Serialize;

#[derive(Debug)]
pub struct Shape<'a> {
    pub kinds: IndexSet<ShapeKind>,
    pub may_import: IndexSet<JsString>,
    pub pure: Vec<JsRegex>,
    pub tests: Vec<JsRegex>,
    pub roots: Vec<JsRegex>,
    pub allowance: ReadAllowance<'a>,
}
#[derive(Debug)]
pub enum ShapeRead<'a> {
    Read(Box<Shape<'a>>),
    Refused { message: JsString },
}
pub fn read_shape<'a>(
    rules: &BoundaryRules,
    catalog: &'a BindingCatalog,
) -> Result<ShapeRead<'a>, GlobError> {
    if declares_read_allowance(rules) && !catalog.unparsed_configs.is_empty() {
        return Ok(ShapeRead::Refused {
            message: format!(
                "a wrangler config cannot be parsed: {}. With \"readAllowance\" declared, a worker whose config is not read has no write site to see, so the allowance would grant silently: fix the file (JSON with comments, or TOML) and run again.",
                catalog.unparsed_configs.join(", ")
            )
            .into(),
        });
    }
    Ok(ShapeRead::Read(Box::new(Shape {
        kinds: rules.application_shape.iter().copied().collect(),
        may_import: rules.application_may_import.iter().cloned().collect(),
        pure: rules
            .pure_dependencies
            .iter()
            .map(glob_to_regexp)
            .collect::<Result<_, _>>()?,
        tests: rules
            .test_files
            .iter()
            .map(glob_to_regexp)
            .collect::<Result<_, _>>()?,
        roots: rules
            .composition_roots
            .iter()
            .map(glob_to_regexp)
            .collect::<Result<_, _>>()?,
        allowance: read_allowance_of(&rules.read_allowance, catalog),
    })))
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShapeFacts {
    pub offending_form: Option<JsString>,
    pub first_write: Option<BindingSite>,
}
pub fn shape_facts_of(
    shape: &Shape<'_>,
    scope: &JsString,
    file: &JsString,
    syntax: &SyntaxFile,
) -> ShapeFacts {
    let entry = shape.kinds.contains(&ShapeKind::IndexNotExportsOnly)
        && file
            .units()
            .rsplit(|unit| *unit == b'/' as u16)
            .find(|part| !part.is_empty())
            .is_some_and(|basename| basename.iter().copied().eq("index.ts".encode_utf16()));
    ShapeFacts {
        offending_form: entry
            .then(|| first_offending_form(syntax))
            .flatten()
            .map(JsString::from),
        first_write: first_write(&shape.allowance, scope, file, syntax),
    }
}
