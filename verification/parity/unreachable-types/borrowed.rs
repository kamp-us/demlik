use demlik_code_graph::{
    extract::assemble::{NodeFields, assemble_graph},
    project::load_cheap_project,
    schema::{ReachabilityReport, Thresholds, UnreachableCategory as Kind},
    text::JsString,
    unreachable::{
        gate::{
            PreparedUnreachableGate, UnreachableMode, UnreachableOutput, UnreachableRunError,
            run_unreachable_gate,
        },
        ledger::{
            UnreachableFinding, UnreachableLedger, UnreachableLedgerEntry, reconcile_unreachable,
        },
    },
};
use std::{cell::Cell, fs, rc::Rc, sync::Arc};
struct Opaque<'a> {
    name: &'a str,
    tick: &'a Cell<u8>,
    action: Box<dyn Fn() -> u8 + 'a>,
}
fn main() {
    let name = String::from("borrowed unreachable context");
    let tick = Cell::new(7);
    let cause = Rc::new(Opaque {
        name: &name,
        tick: &tick,
        action: Box::new(|| tick.get()),
    });
    let scope = JsString::from("a");
    let gated = [Kind::Dead];
    let findings = [UnreachableFinding {
        scope: "foreign".into(),
        kind: Kind::Dead,
        id: "new".into(),
    }];
    let old = Arc::new(UnreachableLedgerEntry {
        finding: UnreachableFinding {
            scope: scope.clone(),
            kind: Kind::Dead,
            id: "gone".into(),
        },
        reason: "kept reason".into(),
    });
    let ledger = UnreachableLedger {
        entries: vec![Arc::clone(&old)],
    };
    let result = reconcile_unreachable(&ledger, &scope, &findings, &gated, &collation()).unwrap();
    assert!(std::ptr::eq(result.unrecorded[0], &findings[0]));
    assert!(Arc::ptr_eq(&old, &result.pruned[0]));
    assert!(std::ptr::eq(result.scope, &scope));
    assert!(std::ptr::eq(result.gated, &gated[..]));
    let retained = Arc::clone(&result.pruned[0]);
    drop(result);
    drop(ledger);
    assert!(Arc::ptr_eq(&retained, &old));
    let root =
        std::env::temp_dir().join(format!("demlik-unreachable-public-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    fs::write(root.join("tsconfig.json"), "{}").unwrap();
    let prepared = collation();
    let loaded = load_cheap_project(&root, None, &prepared).unwrap();
    let mut graph = assemble_graph(
        &loaded,
        Thresholds::default(),
        NodeFields::default(),
        &prepared,
    )
    .unwrap();
    graph.reachability = Some(ReachabilityReport {
        entry_count: 0,
        exported_count: 0,
        reachable_count: 0,
        unreachable: vec![],
        withheld: vec![],
        unguarded: vec![],
    });
    let file = root.join("ledger.json");
    let gate = PreparedUnreachableGate {
        scope: scope.clone(),
        file: file.to_string_lossy().as_ref().into(),
        mode: UnreachableMode::Gate {
            gated: vec![Kind::Dead],
        },
        ledger: UnreachableLedger { entries: vec![old] },
    };
    let same = Rc::clone(&cause);
    let mut emit = |_: &JsString| {
        assert!(file.is_file());
        Err(Rc::clone(&cause))
    };
    let mut report = |_: &JsString| panic!("unexpected report");
    match run_unreachable_gate(
        &gate,
        &graph,
        UnreachableOutput {
            emit: &mut emit,
            report: &mut report,
            json: false,
            pretty: false,
        },
        &collation(),
    ) {
        Err(UnreachableRunError::Emit(actual)) => {
            assert!(Rc::ptr_eq(&actual, &same));
            assert_eq!(actual.name, name);
            assert_eq!(actual.tick.get(), 7);
            assert_eq!((actual.action)(), 7);
        }
        _ => panic!("original borrowed callback failure must escape"),
    };
    fs::remove_dir_all(root).unwrap();
    println!(
        "unreachable: inferred borrowed findings/gated/scope, retained Arc and original opaque callback cause passed"
    );
}

fn collation() -> demlik_code_graph::project::Collation {
    demlik_code_graph::project::Collation::try_node22_en_us().unwrap()
}
