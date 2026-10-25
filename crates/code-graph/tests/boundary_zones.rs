use demlik_code_graph::{
    boundaries::{
        impure_uses::{ImpureFacts, detect_impure_uses},
        rules::{BoundaryRules, place_of, scope_zoning},
        violation::BoundaryViolation,
        zones::{
            impure_violations::{ImpureContext, ImpureFile, impure_violations},
            test_role::judged_in_test_file,
        },
    },
    engine::oxc::parse_type_script,
    text::JsString,
};
use indexmap::IndexSet;
use std::path::Path;

#[test]
fn a_pure_zone_reports_each_global_once_and_the_test_role_keeps_original_crossings() {
    let file: JsString = "src/orders/application/use.ts".into();
    let scope: JsString = "apps/api".into();
    let syntax = parse_type_script(
        Path::new("use.ts"),
        "console.log('x'); console.warn('x'); fetch('url');",
    )
    .unwrap();
    let uses = detect_impure_uses(&syntax);
    let mut rules = BoundaryRules::default();
    rules.features.insert(scope.clone(), vec!["orders".into()]);
    let zoning = scope_zoning(&rules, &scope).unwrap();
    let place = place_of(&file, &zoning);
    let runtime = IndexSet::new();
    let mut violations = impure_violations(ImpureContext {
        scope: &scope,
        module: ImpureFile {
            file: &file,
            facts: ImpureFacts {
                impure_uses: &uses,
                import_edges: &[],
                runtime_specifiers: &runtime,
            },
        },
        place: &place,
    });
    assert_eq!(violations.len(), 2);
    assert!(violations.iter().all(|item| matches!(item, BoundaryViolation::Impure { from, .. } if from == "apps/api/src/orders/application/use.ts")));
    assert!(judged_in_test_file(&violations).is_empty());
    violations.push(BoundaryViolation::CrossFeature {
        from: "apps/api/src/orders/use.test.ts".into(),
        to: "apps/api/src/billing/ports.ts".into(),
        specifier: "../../billing/ports".into(),
        type_only: true,
        from_feature: "orders".into(),
        to_feature: "billing".into(),
    });
    let judged = judged_in_test_file(&violations);
    assert_eq!(judged.len(), 1);
    assert!(std::ptr::eq(judged[0], &violations[2]));
}
