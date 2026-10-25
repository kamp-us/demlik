use crate::{
    boundaries::{ledger::BoundaryKind, rules::in_scope, violation::BoundaryViolation},
    kinds::rules::JsRegex,
    text::JsString,
};

pub const fn judges_test_files(kind: BoundaryKind) -> bool {
    match kind {
        BoundaryKind::CrossFeature
        | BoundaryKind::LibImportsFeature
        | BoundaryKind::OutsideImportsFeatureInternal
        | BoundaryKind::LibraryUndeclared
        | BoundaryKind::LibraryImportsUp
        | BoundaryKind::AdapterLibraryImportedOutsideDriven
        | BoundaryKind::WorkerCallCycle
        | BoundaryKind::RelativeImportCrossesWorkspace
        | BoundaryKind::TestReachesCompositionRoot => true,
        BoundaryKind::ApplicationImportsAdapter
        | BoundaryKind::Impure
        | BoundaryKind::DrivingReachesDriven
        | BoundaryKind::UnknownZone
        | BoundaryKind::IndexNotExportsOnly
        | BoundaryKind::ApplicationImportOutsideAllowlist
        | BoundaryKind::BindingOutsideDrivenAdapter => false,
    }
}
pub fn matches_globs(globs: &[JsRegex], scope: &JsString, file: &JsString) -> bool {
    let repo_relative = in_scope(scope, file);
    globs
        .iter()
        .any(|glob| glob.test(file) || glob.test(&repo_relative))
}
pub fn is_test_file(tests: &[JsRegex], scope: &JsString, file: &JsString) -> bool {
    matches_globs(tests, scope, file)
}
pub fn judged_in_test_file(violations: &[BoundaryViolation]) -> Vec<&BoundaryViolation> {
    violations
        .iter()
        .filter(|violation| judges_test_files(violation.kind()))
        .collect()
}
