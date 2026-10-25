use super::{
    Shape,
    application::{ApplicationFile, ApplicationWorld, application_violations},
};
use crate::{
    boundaries::{
        libraries::Libraries,
        rules::{Place, ScopeZoning, ShapeKind, in_scope, place_of},
        violation::{BoundaryViolation, False},
    },
    syntax::imports::ImportEdge,
    text::JsString,
};
use indexmap::IndexSet;

#[derive(Clone, Copy)]
pub struct ShapedFile<'a> {
    pub file: &'a JsString,
    pub import_edges: &'a [ImportEdge],
    pub runtime_specifiers: &'a IndexSet<JsString>,
    pub offending_form: Option<&'a JsString>,
}
#[derive(Clone, Copy)]
pub struct ShapeContext<'a> {
    pub scope: &'a JsString,
    pub shape: &'a Shape<'a>,
    pub libraries: &'a Libraries<'a>,
    pub zoning: &'a ScopeZoning,
}
pub fn judge_shape(
    context: ShapeContext<'_>,
    file: ShapedFile<'_>,
    place: &Place,
    judged: &[&ImportEdge],
) -> Vec<BoundaryViolation> {
    let mut found = Vec::new();
    if context
        .shape
        .kinds
        .contains(&ShapeKind::IndexNotExportsOnly)
        && let Some(form) = file.offending_form
    {
        let in_feature =
            matches!(place, Place::Feature(feature) if feature.zone_rule().exports_only);
        if in_feature
            || context
                .libraries
                .type_of_dir
                .keys()
                .any(|dir| context.scope == dir)
                && file.file == "src/index.ts"
        {
            found.push(BoundaryViolation::IndexNotExportsOnly {
                from: in_scope(context.scope, file.file),
                to: (),
                specifier: form.clone(),
                type_only: False,
            });
        }
    }
    if context
        .shape
        .kinds
        .contains(&ShapeKind::ApplicationImportOutsideAllowlist)
        && let Place::Feature(feature) = place
        && let Some(own) = feature.zone_rule().import_allowlist
    {
        found.extend(application_violations(
            ApplicationFile {
                scope: context.scope,
                file: file.file,
                feature: feature.feature(),
                own,
                import_edges: file.import_edges,
                runtime_specifiers: file.runtime_specifiers,
                judged,
            },
            ApplicationWorld {
                rules: context.shape,
                libraries: context.libraries,
                place_of: &|target| place_of(target, context.zoning),
            },
        ));
    }
    found
}
