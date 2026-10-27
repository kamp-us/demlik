use demlik_code_graph::{
    schema::SmellKind as Kind,
    smells::ledger::{SmellLedger, reconcile_smells},
    text::JsString,
};
fn main() {
    let scope = JsString::from("app");
    let findings = [];
    let held;
    {
        let local = SmellLedger {
            gated: vec![Kind::HighComplexity],
            entries: vec![],
        };
        held = reconcile_smells(
            &local,
            &scope,
            &findings,
            &[Kind::HighComplexity],
            &collation(),
        )
        .unwrap();
    }
    println!("{}", held.gated.len());
}

fn collation() -> demlik_code_graph::project::Collation {
    demlik_code_graph::project::Collation::try_node22_en_us().unwrap()
}
