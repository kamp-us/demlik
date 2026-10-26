#![allow(
    clippy::arc_with_non_send_sync,
    reason = "Conformance carries original opaque local values, not Send/Clone/serde domain models."
)]
use demlik_tea::{ReadStep, Step, data::JsText};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    io::{self, BufRead},
    rc::Rc,
    sync::Arc,
};
#[expect(
    dead_code,
    reason = "Only numeric projection is used from the shared parity wire owner."
)]
#[path = "../../parity/src/paginate_queue/wire.rs"]
mod wire;
#[path = "compose_driver/workflow.rs"]
mod workflow;
type Calls = RefCell<Vec<&'static str>>;
macro_rules! observe {($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{$calls.borrow_mut().push(stringify!($function));$function($($arg),*)}};}
macro_rules! observe_expr {
    ($calls:expr,$expression:expr) => {{
        $calls.borrow_mut().push(stringify!($expression));
        $expression
    }};
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Text {
    Utf8(String),
    Units {
        #[serde(rename = "$utf16")]
        units: Vec<u16>,
    },
}
impl Text {
    fn value(&self) -> JsText {
        match self {
            Self::Utf8(s) => s.clone().into(),
            Self::Units { units } => JsText::from_units(units.clone()),
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum ValueSpec {
    Undefined,
    Null,
    Bool { value: bool },
    Number { value: wire::Number },
    Text { value: Text },
    Token { n: wire::Number },
    Function { n: wire::Number },
}
struct Token<'a> {
    n: Cell<f64>,
    _label: &'a str,
    _capability: Box<dyn Fn() + 'a>,
}
enum Item<'a> {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    Text(JsText),
    Token(Rc<Token<'a>>),
    Function(Rc<Token<'a>>),
}
fn items(specs: &[ValueSpec]) -> Vec<Item<'_>> {
    specs
        .iter()
        .map(|s| match s {
            ValueSpec::Undefined => Item::Undefined,
            ValueSpec::Null => Item::Null,
            ValueSpec::Bool { value } => Item::Bool(*value),
            ValueSpec::Number { value } => Item::Number(value.value()),
            ValueSpec::Text { value } => Item::Text(value.value()),
            ValueSpec::Token { n } => Item::Token(Rc::new(Token {
                n: Cell::new(n.value()),
                _label: "opaque",
                _capability: Box::new(|| {}),
            })),
            ValueSpec::Function { n } => Item::Function(Rc::new(Token {
                n: Cell::new(n.value()),
                _label: "callable",
                _capability: Box::new(|| {}),
            })),
        })
        .collect()
}
fn view(value: &Item<'_>) -> Value {
    match value {
        Item::Undefined => json!({"type":"undefined"}),
        Item::Null => json!({"type":"null"}),
        Item::Bool(v) => json!({"type":"bool","value":v}),
        Item::Number(v) => json!({"type":"number","value":wire::number(*v)}),
        Item::Text(v) => json!({"type":"text","units":v.as_units()}),
        Item::Token(t) => json!({"type":"token","n":wire::number(t.n.get())}),
        Item::Function(t) => json!({"type":"function","n":wire::number(t.n.get())}),
    }
}
fn set_token(items: &[Item<'_>], slot: usize, n: f64) {
    match &items[slot] {
        Item::Token(t) | Item::Function(t) => t.n.set(n),
        _ => panic!("validated token effect"),
    }
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Effect {
    SetInput { n: wire::Number },
    SetToken { slot: usize, n: wire::Number },
    Append { reader: usize },
    Remove { index: usize },
    Reverse,
    Truncate { len: usize },
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum ReadOp {
    Defer,
    Answer { slot: usize },
    Throw { slot: usize },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reader {
    name: Text,
    action: ReadOp,
    #[serde(default)]
    effects: Vec<Effect>,
    #[serde(default)]
    mutate_on: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InputSpec {
    n: wire::Number,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadScript {
    input: InputSpec,
    values: Vec<ValueSpec>,
    readers: Vec<Reader>,
    order: Vec<usize>,
    absent: usize,
    #[serde(default)]
    direct: Option<usize>,
    #[serde(default)]
    post: Vec<Effect>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum Field {
    Left,
    Right,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LiftScript {
    field: Field,
    same_slice: bool,
    next_slot: usize,
    commands: Vec<usize>,
    values: Vec<ValueSpec>,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Script {
    Read(ReadScript),
    Lift(LiftScript),
    Workflow(workflow::Script),
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    input: Script,
}
struct Input {
    n: Cell<f64>,
    _capability: Box<dyn Fn()>,
}
fn read(script: &ReadScript, calls: &Calls) -> Value {
    let values = items(&script.values);
    let input = Input {
        n: Cell::new(script.input.n.value()),
        _capability: Box::new(|| {}),
    };
    let log = RefCell::new(vec![]);
    let counts = RefCell::new(vec![0; script.readers.len()]);
    let order = Rc::new(RefCell::new(script.order.clone()));
    let pool = Rc::new(RefCell::new(Vec::<
        Rc<ReadStep<'_, '_, Input, &Item<'_>, &Item<'_>>>,
    >::new()));
    for (index, spec) in script.readers.iter().enumerate() {
        let pool_weak = Rc::downgrade(&pool);
        let order = Rc::clone(&order);
        let input_ref = &input;
        let values = &values;
        let log = &log;
        let counts = &counts;
        let reader = Rc::new_cyclic(
            |weak: &std::rc::Weak<ReadStep<'_, '_, Input, &Item<'_>, &Item<'_>>>| {
                let receiver = weak.clone();
                ReadStep {
                    name: spec.name.value(),
                    read: Box::new(move |actual: &Input| {
                        let owner = receiver.upgrade().expect("live reader");
                        let expected =
                            pool_weak.upgrade().expect("live pool").borrow()[index].clone();
                        let call = {
                            let mut n = counts.borrow_mut();
                            let call = n[index];
                            n[index] += 1;
                            call
                        };
                        log.borrow_mut().push(json!({"reader":index,"call":call,"nameUnits":owner.name.as_units(),"sameInput":std::ptr::eq(actual,input_ref),"sameReceiver":Rc::ptr_eq(&owner,&expected),"n":wire::number(actual.n.get())}));
                        if call == spec.mutate_on {
                            for effect in &spec.effects {
                                match effect {
                                    Effect::SetInput { n } => actual.n.set(n.value()),
                                    Effect::SetToken { slot, n } => {
                                        set_token(values, *slot, n.value())
                                    }
                                    Effect::Append { reader } => order.borrow_mut().push(*reader),
                                    Effect::Remove { index } => {
                                        if *index < order.borrow().len() {
                                            order.borrow_mut().remove(*index);
                                        }
                                    }
                                    Effect::Reverse => order.borrow_mut().reverse(),
                                    Effect::Truncate { len } => order.borrow_mut().truncate(*len),
                                }
                            }
                        }
                        match spec.action {
                            ReadOp::Defer => Ok(None),
                            ReadOp::Answer { slot } => {
                                if matches!(values[slot], Item::Undefined) {
                                    Ok(None)
                                } else {
                                    Ok(Some(&values[slot]))
                                }
                            }
                            ReadOp::Throw { slot } => Err(&values[slot]),
                        }
                    }),
                }
            },
        );
        pool.borrow_mut().push(reader);
    }
    let result = if let Some(index) = script.direct {
        let reader = pool.borrow()[index].clone();
        observe_expr!(calls, (reader.read)(&input)).map(|v| v.unwrap_or(&values[script.absent]))
    } else {
        let at = Cell::new(0);
        let iterator = std::iter::from_fn(|| {
            let index = at.get();
            let next = order.borrow().get(index).copied()?;
            at.set(index + 1);
            let reader = pool.borrow()[next].clone();
            Some(reader)
        });
        observe!(
            calls,
            demlik_tea::read_in_order,
            &input,
            iterator,
            &values[script.absent]
        )
    };
    let (status, result) = match result {
        Ok(v) => ("ok", v),
        Err(v) => ("error", v),
    };
    let before = view(result);
    let slot = values.iter().position(|v| std::ptr::eq(v, result)).unwrap();
    for e in &script.post {
        match e {
            Effect::SetInput { n } => input.n.set(n.value()),
            Effect::SetToken { slot, n } => set_token(&values, *slot, n.value()),
            _ => panic!("post effects are scalar only"),
        }
    }
    json!({"status":status,"slot":slot,"value":before,"after":view(result),"sameOriginal":std::ptr::eq(result,&values[slot]),"inputN":wire::number(input.n.get()),"log":log.borrow().clone(),"order":order.borrow().clone()})
}
struct Host<'a> {
    left: &'a Item<'a>,
    right: &'a Item<'a>,
    context: &'a Input,
}
struct Command<'a> {
    slot: usize,
    value: &'a Item<'a>,
}
fn lift(script: &LiftScript, calls: &Calls) -> Value {
    let values = items(&script.values);
    let input = Input {
        n: Cell::new(17.0),
        _capability: Box::new(|| {}),
    };
    let host = Arc::new(Host {
        left: &values[0],
        right: &values[1],
        context: &input,
    });
    let old = match script.field {
        Field::Left => host.left,
        Field::Right => host.right,
    };
    let replacement = if script.same_slice {
        old
    } else {
        &values[script.next_slot]
    };
    let commands = script
        .commands
        .iter()
        .map(|slot| Command {
            slot: *slot,
            value: &values[*slot],
        })
        .collect::<Vec<_>>();
    let pointer = commands.as_ptr();
    let capacity = commands.capacity();
    let out = observe!(
        calls,
        demlik_tea::lift_slice,
        Arc::clone(&host),
        Step::new(replacement, commands),
        |state, slice| match script.field {
            Field::Left => Arc::new(Host {
                left: slice,
                right: state.right,
                context: state.context
            }),
            Field::Right => Arc::new(Host {
                left: state.left,
                right: slice,
                context: state.context
            }),
        }
    );
    let (actual, sibling) = match script.field {
        Field::Left => (out.state.left, std::ptr::eq(out.state.right, host.right)),
        Field::Right => (out.state.right, std::ptr::eq(out.state.left, host.left)),
    };
    json!({"fresh":!Arc::ptr_eq(&out.state,&host),"sliceIdentity":std::ptr::eq(actual,replacement),"siblingIdentity":sibling,"contextIdentity":std::ptr::eq(out.state.context,&input),"original":[view(host.left),view(host.right)],"next":[view(out.state.left),view(out.state.right)],"commandsOwner":out.commands.as_ptr()==pointer&&out.commands.capacity()==capacity,"commands":out.commands.iter().map(|c|json!({"slot":c.slot,"value":view(c.value),"sameOriginal":std::ptr::eq(c.value,&values[c.slot])})).collect::<Vec<_>>()})
}
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let case: Case = serde_json::from_str(&line).unwrap();
        let calls = Calls::new(vec![]);
        let comparison = match case.input {
            Script::Read(s) => read(&s, &calls),
            Script::Lift(s) => lift(&s, &calls),
            Script::Workflow(s) => workflow::run(&s, &calls),
        };
        println!(
            "{}",
            json!({"id":case.id,"comparison":comparison,"observedRustCalls":calls.into_inner()})
        );
    }
}
