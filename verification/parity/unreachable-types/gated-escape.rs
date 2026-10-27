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
        let local = [Kind::Dead];
        held = reconcile_unreachable(&ledger, &scope, &findings, &local);
    }
    println!("{} {}", held.gated.len(), gated.len());
}
