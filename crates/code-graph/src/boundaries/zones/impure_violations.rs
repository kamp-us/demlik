use crate::{
    boundaries::{
        impure_uses::{ImpureFacts, impure_names_of},
        rules::{FeatureFile, Place, in_scope},
        violation::BoundaryViolation,
    },
    text::JsString,
};

pub struct ImpureFile<'a> {
    pub file: &'a JsString,
    pub facts: ImpureFacts<'a>,
}
pub struct ImpureContext<'a> {
    pub scope: &'a JsString,
    pub module: ImpureFile<'a>,
    pub place: &'a Place,
}
pub fn impure_violations(context: ImpureContext<'_>) -> Vec<BoundaryViolation> {
    let may_be_impure = match context.place {
        Place::Feature(FeatureFile::PerFeature { zone, .. }) => zone.rule.may_be_impure,
        Place::Feature(FeatureFile::Port { zone, .. }) => zone.rule.may_be_impure,
        Place::Lib | Place::Elsewhere => true,
    };
    if may_be_impure {
        return Vec::new();
    }
    impure_names_of(context.module.facts)
        .into_iter()
        .map(|name| BoundaryViolation::Impure {
            from: in_scope(context.scope, context.module.file),
            to: (),
            specifier: name,
            type_only: false,
        })
        .collect()
}
