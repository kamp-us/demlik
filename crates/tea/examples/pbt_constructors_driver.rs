#![allow(
    clippy::arc_with_non_send_sync,
    reason = "Conformance forwards original borrowed opaque local payloads."
)]
use demlik_tea::{Tagged, data::JsText, work_queue::QueueField};
use proptest::{
    strategy::{Just, Strategy, ValueTree},
    test_runner::{Config, RngSeed, TestRunner, noop_result_cache},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    fmt,
    io::{self, BufRead},
    rc::Rc,
    sync::Arc,
};
#[expect(
    dead_code,
    reason = "Only the canonical numeric wire projection is used here."
)]
#[path = "../../parity/src/paginate_queue/wire.rs"]
mod wire;
type Calls = RefCell<Vec<&'static str>>;
macro_rules! observe {($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{$calls.borrow_mut().push(stringify!($function));$function($($arg),*)}};}
#[path = "pbt_constructors_driver/invoice.rs"]
mod invoice;
#[path = "pbt_constructors_driver/native.rs"]
mod native;
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
    Object { n: wire::Number },
    Array { n: wire::Number },
    Function { n: wire::Number },
}
struct Opaque<'a> {
    n: Rc<Cell<f64>>,
    _label: &'a str,
    capability: Box<dyn Fn() -> f64 + 'a>,
}
enum Item<'a> {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    Text(JsText),
    Object(Rc<Opaque<'a>>),
    Array(Rc<Opaque<'a>>),
    Function(Rc<Opaque<'a>>),
}
fn items(specs: &[ValueSpec]) -> Vec<Item<'_>> {
    specs
        .iter()
        .map(|spec| {
            let opaque = |n: f64| {
                let value = Rc::new(Cell::new(n));
                let captured = Rc::clone(&value);
                Rc::new(Opaque {
                    n: value,
                    _label: "borrowed opaque payload",
                    capability: Box::new(move || captured.get()),
                })
            };
            match spec {
                ValueSpec::Undefined => Item::Undefined,
                ValueSpec::Null => Item::Null,
                ValueSpec::Bool { value } => Item::Bool(*value),
                ValueSpec::Number { value } => Item::Number(value.value()),
                ValueSpec::Text { value } => Item::Text(value.value()),
                ValueSpec::Object { n } => Item::Object(opaque(n.value())),
                ValueSpec::Array { n } => Item::Array(opaque(n.value())),
                ValueSpec::Function { n } => Item::Function(opaque(n.value())),
            }
        })
        .collect()
}
fn view(item: &Item<'_>) -> Value {
    match item {
        Item::Undefined => json!({"type":"undefined"}),
        Item::Null => json!({"type":"null"}),
        Item::Bool(v) => json!({"type":"bool","value":v}),
        Item::Number(v) => json!({"type":"number","value":wire::number(*v)}),
        Item::Text(v) => json!({"type":"text","units":v.as_units()}),
        Item::Object(v) => json!({"type":"object","n":wire::number(v.n.get())}),
        Item::Array(v) => json!({"type":"array","n":wire::number(v.n.get())}),
        Item::Function(v) => {
            json!({"type":"function","n":wire::number(v.n.get()),"call":wire::number((v.capability)())})
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Mutation {
    slot: usize,
    n: wire::Number,
}
fn mutate(values: &[Item<'_>], mutations: &[Mutation]) {
    for effect in mutations {
        match &values[effect.slot] {
            Item::Object(v) | Item::Array(v) | Item::Function(v) => v.n.set(effect.n.value()),
            _ => panic!("mutation must target an opaque fixture payload"),
        }
    }
}
#[derive(Clone, Copy)]
struct Mask<'a> {
    fields: [Option<&'a Item<'a>>; 2],
}
impl fmt::Debug for Mask<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Mask")
    }
}
struct Fields<'a> {
    value: QueueField<&'a Item<'a>>,
    extra: QueueField<&'a Item<'a>>,
    _capability: Box<dyn Fn() + 'a>,
}
impl fmt::Debug for Fields<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Fields")
    }
}
enum Msg<'a> {
    Constant { tag: &'a str },
    Record { tag: &'a str, fields: Fields<'a> },
}
impl Tagged for Msg<'_> {
    fn tag(&self) -> &str {
        match self {
            Self::Constant { tag } | Self::Record { tag, .. } => tag,
        }
    }
}
impl fmt::Debug for Msg<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.tag())
    }
}
fn field<'a>(value: Option<&'a Item<'a>>) -> QueueField<&'a Item<'a>> {
    match value {
        None => QueueField::Absent,
        Some(Item::Undefined) => QueueField::Undefined,
        Some(v) => QueueField::Value(v),
    }
}
fn field_view(actual: &QueueField<&Item<'_>>, expected: Option<&Item<'_>>) -> Value {
    match actual {
        QueueField::Absent => json!({"present":false,"sameOriginal":expected.is_none()}),
        QueueField::Undefined => {
            json!({"present":true,"value":{"type":"undefined"},"sameOriginal":matches!(expected,Some(Item::Undefined))})
        }
        QueueField::Value(value) => {
            json!({"present":true,"value":view(value),"sameOriginal":expected.is_some_and(|original|std::ptr::eq(*value,original))})
        }
    }
}
fn message_view(message: &Msg<'_>, expected: [Option<&Item<'_>>; 2]) -> Value {
    let mut keys = vec!["type"];
    let fields = match message {
        Msg::Constant { .. } => {
            json!({"value":{"present":false,"sameOriginal":true},"extra":{"present":false,"sameOriginal":true}})
        }
        Msg::Record { fields, .. } => {
            if !fields.value.is_absent() {
                keys.push("value")
            }
            if !fields.extra.is_absent() {
                keys.push("extra")
            }
            json!({"value":field_view(&fields.value,expected[0]),"extra":field_view(&fields.extra,expected[1])})
        }
    };
    json!({"tagUnits":message.tag().encode_utf16().collect::<Vec<_>>(),"keys":keys,"fields":fields})
}
fn runner() -> TestRunner {
    TestRunner::new(Config {
        cases: 1,
        rng_seed: RngSeed::Fixed(731),
        failure_persistence: None,
        result_cache: noop_result_cache,
        ..Config::default()
    })
}
fn sampled<'a>(
    strategy: impl Strategy<Value = Arc<Msg<'a>>>,
    draws: usize,
    runner: &mut TestRunner,
) -> Result<Vec<Arc<Msg<'a>>>, String> {
    (0..draws)
        .map(|_| {
            strategy
                .new_tree(runner)
                .map(|tree| tree.current())
                .map_err(|error| error.to_string())
        })
        .collect()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConstantScript {
    tag: String,
    draws: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordScript {
    tag: String,
    draws: usize,
    values: Vec<ValueSpec>,
    #[serde(default)]
    value: QueueField<usize>,
    #[serde(default)]
    extra: QueueField<usize>,
    #[serde(default)]
    post: Vec<Mutation>,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Script {
    Constant(ConstantScript),
    Record(RecordScript),
    Invoice(invoice::Script),
    Native(native::Script),
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    input: Script,
}
fn execute(case: Case) -> Value {
    let calls = RefCell::new(vec![]);
    let mut random = runner();
    let comparison = match &case.input {
        Script::Invoice(input) => return invoice::execute(&case.id, input),
        Script::Native(input) => return native::execute(&case.id, input),
        Script::Constant(input) => {
            let strategy = observe!(
                &calls,
                demlik_tea::pbt::constant_msg,
                Msg::Constant { tag: &input.tag }
            );
            match sampled(strategy, input.draws, &mut random) {
                Ok(messages) => {
                    let before = messages
                        .iter()
                        .map(|m| message_view(m, [None, None]))
                        .collect::<Vec<_>>();
                    json!({"status":"ok","before":before,"after":before,"sameAsFirst":messages.iter().map(|m|Arc::ptr_eq(m,&messages[0])).collect::<Vec<_>>()})
                }
                Err(reason) => json!({"status":"refused","phase":"generation","reason":reason}),
            }
        }
        Script::Record(input) => {
            let values = items(&input.values);
            let expected = [
                input.value.value().map(|i| &values[*i]),
                input.extra.value().map(|i| &values[*i]),
            ];
            let fields = Just(Mask { fields: expected }).prop_map(|mask| Fields {
                value: field(mask.fields[0]),
                extra: field(mask.fields[1]),
                _capability: Box::new(|| {}),
            });
            let strategy = observe!(&calls, demlik_tea::pbt::record_msg, fields, |fields| {
                Msg::Record {
                    tag: &input.tag,
                    fields,
                }
            });
            match sampled(strategy, input.draws, &mut random) {
                Ok(messages) => {
                    let before = messages
                        .iter()
                        .map(|m| message_view(m, expected))
                        .collect::<Vec<_>>();
                    mutate(&values, &input.post);
                    let after = messages
                        .iter()
                        .map(|m| message_view(m, expected))
                        .collect::<Vec<_>>();
                    json!({"status":"ok","before":before,"after":after,"sameAsFirst":messages.iter().map(|m|Arc::ptr_eq(m,&messages[0])).collect::<Vec<_>>()})
                }
                Err(reason) => json!({"status":"refused","phase":"generation","reason":reason}),
            }
        }
    };
    json!({"id":case.id,"comparison":comparison,"diagnostics":{},"observedRustCalls":calls.into_inner()})
}
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.expect("input line");
        if line.trim().is_empty() {
            continue;
        }
        let case: Case = serde_json::from_str(&line).expect("typed case protocol");
        println!("{}", execute(case));
    }
}
