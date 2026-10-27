use demlik_code_graph::{
    schema::UnreachableCategory as Kind,
    text::JsString,
    unreachable::ledger::{UnreachableFinding, UnreachableLedger, reconcile_unreachable},
};
fn main() {
    let scope = JsString::from("a");
    let ledger = UnreachableLedger::default();
    let findings = [UnreachableFinding {
        scope: scope.clone(),
        kind: Kind::Dead,
        id: "x".into(),
    }];
    let gated = [Kind::Dead];
    let held;
    {
        let local = [UnreachableFinding {
            scope: scope.clone(),
            kind: Kind::Dead,
            id: "x".into(),
        }];
        held = reconcile_unreachable(&ledger, &scope, &local, &gated);
    }
    println!("{} {}", held.unrecorded.len(), findings.len());
}
