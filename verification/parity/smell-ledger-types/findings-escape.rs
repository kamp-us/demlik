use demlik_code_graph::{
    schema::SmellKind as Kind,
    smells::ledger::{SmellFinding, SmellLedger, reconcile_smells},
    text::JsString,
};
fn main() {
    let ledger = SmellLedger {
        gated: vec![Kind::HighComplexity],
        entries: vec![],
    };
    let scope = JsString::from("app");
    let held;
    {
        let local = [SmellFinding {
            rule: Kind::HighComplexity,
            target: "app/x".into(),
            value: 3.0,
        }];
        held = reconcile_smells(&ledger, &scope, &local, &[Kind::HighComplexity]);
    }
    println!("{}", held.unrecorded.len());
}
