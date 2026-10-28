use demlik_code_graph::{
    cli::io::{CliIo, exit_with, output_to},
    extract::assemble::{NodeFields, assemble_graph},
    project::load_cheap_project,
    schema::{Severity, Smell, SmellKind as Kind, SmellTarget},
    smells::{
        gate::{PreparedSmellGate, SmellGateMode, run_smell_ledger_gate},
        ledger::{SmellFinding, SmellLedger, SmellLedgerEntry, reconcile_smells},
    },
    text::JsString,
};
use std::{cell::Cell, fs, io::Write, rc::Rc, sync::Arc};
struct Opaque<'a> {
    name: &'a str,
    tick: &'a Cell<u8>,
    action: Box<dyn Fn() -> u8 + 'a>,
}
struct Writer<'a> {
    hits: &'a Cell<usize>,
    bytes: Vec<u8>,
}
impl Write for Writer<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.hits.set(self.hits.get() + 1);
        self.bytes.extend(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn main() {
    let name = String::from("borrowed cause");
    let tick = Cell::new(7);
    let cause = Rc::new(Opaque {
        name: &name,
        tick: &tick,
        action: Box::new(|| tick.get()),
    });
    let scope = JsString::from("app");
    let old = Arc::new(SmellLedgerEntry {
        finding: SmellFinding {
            rule: Kind::HighComplexity,
            target: "other/x".into(),
            value: 3.0,
        },
        reason: "first".into(),
    });
    let ledger = SmellLedger {
        gated: vec![Kind::HighComplexity],
        entries: vec![Arc::clone(&old)],
    };
    let findings = [SmellFinding {
        rule: Kind::HighComplexity,
        target: "foreign/new".into(),
        value: 4.0,
    }];
    let result = reconcile_smells(
        &ledger,
        &scope,
        &findings,
        &[Kind::HighComplexity],
        &collation(),
    )
    .unwrap();
    assert!(std::ptr::eq(result.gated, ledger.gated.as_slice()));
    assert!(std::ptr::eq(result.unrecorded[0], &findings[0]));
    assert!(Arc::ptr_eq(&result.kept.entries[0], &old));
    let held = Arc::clone(&result.kept.entries[0]);
    drop(result);
    drop(ledger);
    assert!(Arc::ptr_eq(&held, &old));
    let root = std::env::temp_dir().join(format!("demlik-smell-public-{}", std::process::id()));
    fs::create_dir(&root).unwrap();
    fs::write(root.join("tsconfig.json"), "{}").unwrap();
    let loaded = load_cheap_project(&root, None).unwrap();
    let mut graph = assemble_graph(
        &loaded,
        Default::default(),
        NodeFields::default(),
        &demlik_code_graph::project::Collation::try_node22_en_us().unwrap(),
    )
    .unwrap();
    graph.smells = vec![Smell {
        kind: Kind::HighComplexity,
        target: SmellTarget::Module {
            file: "x.ts".into(),
        },
        value: 3,
        threshold: 1,
        severity: Severity::Warn,
    }];
    let gate = PreparedSmellGate {
        mode: SmellGateMode::Accept {
            reason: "new".into(),
        },
        file: root.join("ledger.json").to_string_lossy().as_ref().into(),
        scope,
        ledger: SmellLedger {
            gated: vec![Kind::HighComplexity],
            entries: vec![old],
        },
    };
    let rendered = run_smell_ledger_gate(&gate, &graph, false, false, &collation()).unwrap();
    assert!(root.join("ledger.json").is_file());
    let same = Rc::clone(&cause);
    let emit = |_: &JsString| Err::<(), _>(Rc::clone(&cause));
    let actual = emit(&rendered.stdout).err().unwrap();
    assert!(Rc::ptr_eq(&actual, &same));
    assert_eq!(actual.name, name);
    assert_eq!(actual.tick.get(), 7);
    assert_eq!((actual.action)(), 7);
    let hits = Cell::new(0);
    let mut writer = Writer {
        hits: &hits,
        bytes: vec![],
    };
    let mut errors = vec![];
    {
        let mut io = CliIo::new(&mut writer, &mut errors, None);
        output_to(None).emit(&mut io, &rendered.stdout).unwrap();
        exit_with(&mut io, f64::from(rendered.exit_code)).unwrap();
        assert_eq!(io.normal_exit_code(), 0);
    }
    assert_eq!(hits.get(), 1);
    assert!(errors.is_empty());
    assert!(writer.bytes.ends_with(&[10]));
    fs::remove_dir_all(root).unwrap();
    println!("borrowed/Rc/Arc owners, opaque cause, existing output and exit passed");
}

fn collation() -> demlik_code_graph::project::Collation {
    demlik_code_graph::project::Collation::try_node22_en_us().unwrap()
}
