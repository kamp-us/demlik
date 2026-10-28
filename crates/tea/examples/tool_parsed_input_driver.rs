//! Direct already-parsed invoice commands through the public router and actor.
use demlik_tea::{
    Machine, PlainData as D, Step, Sub, Tagged,
    agent::tool::{self, ErrorFamily, ToolContext, ToolFailure, ToolInput, ToolSpec},
    command::{CommandEdge, CommandFamily, Failure, Issue, Outcome, SchemaError, Settlement},
    data::{decode_json, plain_data, stringify_json},
    llm_call::Schema,
    resilience::resilient_call::CallValue,
    runtime::{NoSubscriptions, Options, Profile},
};
use serde::{Deserialize, Serialize};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    io::{self, BufRead},
    rc::Rc,
    time::Duration,
};

demlik_tea::tool_router! { mod invoices { Read(read), Check(check) } }
thread_local! {static CALLS:RefCell<Vec<&'static str>>=const{RefCell::new(Vec::new())};}
macro_rules! observe {($f:path $(,$arg:expr)* $(,)?)=>{{let v=$f($($arg),*);CALLS.with(|c|c.borrow_mut().push(stringify!($f)));v}};}
#[derive(Deserialize)]
struct Frame {
    id: String,
    input: Input,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    mode: String,
    scenario: String,
    profile: Option<String>,
}
fn obj(fields: impl IntoIterator<Item = (&'static str, D)>) -> D {
    D::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn text(value: impl Into<demlik_tea::data::JsText>) -> D {
    D::String(value.into())
}
fn wire<T: Serialize>(value: &T) -> D {
    decode_json(&stringify_json(&plain_data(value).unwrap()).unwrap()).unwrap()
}
fn field<'a>(value: &'a D, key: &str) -> &'a D {
    let D::Object(fields) = value else {
        panic!("expected record")
    };
    &fields[key]
}
fn string(value: &D) -> &str {
    let D::String(value) = value else {
        panic!("expected text")
    };
    value.as_utf8().unwrap()
}
#[derive(Serialize)]
#[serde(transparent)]
struct Declared(Rc<D>);
impl Tagged for Declared {
    fn tag(&self) -> &str {
        string(field(&self.0, "_tag"))
    }
}
struct Fixture {
    trace: RefCell<Vec<String>>,
    input_calls: Cell<u32>,
    args: Rc<D>,
    returned: Rc<D>,
    failure: Rc<Declared>,
    identity: bool,
    failed: bool,
}
struct Parser {
    fixture: Rc<Fixture>,
    owner: &'static str,
    output: bool,
}
impl Schema for Parser {
    type Raw = Rc<D>;
    type Output = Rc<D>;
    type Error = SchemaError;
    fn parse(&self, raw: Rc<D>) -> Result<Rc<D>, CallValue<SchemaError>> {
        let f = &self.fixture;
        if !self.output {
            f.input_calls.set(f.input_calls.get() + 1);
            f.trace.borrow_mut().push(format!("input:{}", self.owner));
            return Err(CallValue::value(SchemaError::Issues(vec![Issue::new(
                "",
                "raw input requires an invoice envelope",
            )])));
        }
        f.trace.borrow_mut().push(format!("output:{}", self.owner));
        if f.identity {
            return Ok(raw);
        }
        let D::Number(total) = field(&raw, "total") else {
            panic!("expected total")
        };
        Ok(Rc::new(obj([
            (
                "total",
                D::Number(total + if self.owner == "B" { 100.0 } else { 1.0 }),
            ),
            ("parser", text(self.owner)),
        ])))
    }
}
struct Host {
    marker: &'static str,
}
type Def = tool::ToolDef<'static, D, D, D, Parser, Parser, Declared, D, Host, Infallible>;
type Router = invoices::Router<Def, Def>;
type Command = invoices::Commands<Def, Def>;
type Message = <Command as CommandFamily>::Msg;
fn make(
    name: &'static str,
    owner: &'static str,
    fixture: &Rc<Fixture>,
) -> (Rc<Def>, Rc<Parser>, Rc<Parser>) {
    let input = Rc::new(Parser {
        fixture: Rc::clone(fixture),
        owner,
        output: false,
    });
    let output = Rc::new(Parser {
        fixture: Rc::clone(fixture),
        owner,
        output: true,
    });
    let f = Rc::clone(fixture);
    let tags = match owner {
        "A" => vec!["a_only"],
        "B" => vec!["b_only"],
        _ => vec![],
    };
    let def = observe!(
        demlik_tea::agent::tool::tool,
        name,
        ToolSpec::new(
            Rc::clone(&input),
            Rc::clone(&output),
            ErrorFamily::new(tags, |e: &Declared| Ok(e.0.as_ref().clone()))
        ),
        move |args: &Rc<D>, ctx: ToolContext<'_, Host>| {
            let f = Rc::clone(&f);
            Box::pin(async move {
                assert!(Rc::ptr_eq(args, &f.args));
                f.trace.borrow_mut().push(format!(
                    "handler:{owner}:{}:{}",
                    string(field(args, "invoice")),
                    ctx.host.marker
                ));
                Ok(if f.failed {
                    Outcome::err(Rc::clone(&f.failure))
                } else {
                    Outcome::ok(Rc::clone(&f.returned))
                })
            })
        }
    )
    .unwrap();
    (def, input, output)
}
fn describe(router: &Router, f: &Fixture, message: &Message) -> D {
    let invoices::Messages::Read(msg) = message else {
        panic!("unexpected tool family")
    };
    let (result_same, error_same) = match msg.outcome() {
        Settlement::Ok(value) => (D::Bool(Rc::ptr_eq(value, &f.returned)), D::Null),
        Settlement::Err(Failure::Declared(ToolFailure::Declared(error))) => {
            (D::Null, D::Bool(Rc::ptr_eq(error, &f.failure)))
        }
        _ => panic!("unexpected failure"),
    };
    obj([
        ("message", wire(message)),
        (
            "outcome",
            wire(&observe!(invoices::Router::outcome_of, router, message).unwrap()),
        ),
        (
            "own",
            obj([
                (
                    "argsSame",
                    D::Bool(Rc::ptr_eq(&msg.cmd().input().args, &f.args)),
                ),
                ("resultSame", result_same),
                ("errorSame", error_same),
            ]),
        ),
    ])
}
#[derive(Serialize)]
struct State {
    messages: Vec<D>,
}
impl Tagged for State {
    fn tag(&self) -> &str {
        "state"
    }
}
async fn execute(input: Input) -> D {
    assert!(input.mode == "edge" || input.mode == "runtime");
    let selected = input.scenario.starts_with("selected");
    let owner = if selected { "B" } else { "A" };
    let f = Rc::new(Fixture {
        trace: RefCell::new(vec![]),
        input_calls: Cell::new(0),
        args: Rc::new(obj([("invoice", text("already-parsed"))])),
        returned: Rc::new(obj([
            ("total", D::Number(20.0)),
            ("parser", text(format!("raw-{owner}"))),
        ])),
        failure: Rc::new(Declared(Rc::new(obj([
            ("_tag", text(if selected { "b_only" } else { "a_only" })),
            ("detail", text("original")),
        ])))),
        identity: input.scenario == "identity",
        failed: input.scenario.ends_with("error"),
    });
    let (a, input_a, output_a) = make("read_invoice", "A", &f);
    let (b, input_b, output_b) = make("read_invoice", "B", &f);
    let (check, _, _) = make("check_invoice", "check", &f);
    let chosen = if selected {
        Rc::clone(&b)
    } else {
        Rc::clone(&a)
    };
    let schemas_same = Rc::ptr_eq(a.input_schema(), &input_a)
        && Rc::ptr_eq(b.input_schema(), &input_b)
        && Rc::ptr_eq(
            chosen.output_schema(),
            if selected { &output_b } else { &output_a },
        );
    let router = Rc::new(observe!(invoices::Router::new, chosen, check).unwrap());
    let command = invoices::Commands::Read(observe!(
        demlik_tea::agent::tool::ToolDefinition::from_input,
        &a,
        ToolInput {
            call_id: "direct-17".into(),
            args: Rc::clone(&f.args)
        }
    ));
    let command_wire = wire(&command);
    let messages = if input.mode == "edge" {
        let returned = observe!(
            invoices::Router::interpret,
            router.as_ref(),
            &command,
            ToolContext::bare(&Host { marker: "host" })
        )
        .await
        .unwrap();
        let settled = observe!(
            demlik_tea::command::CommandFamily::settle_in,
            command,
            returned,
            &CommandEdge::new(|| 17.25)
        )
        .unwrap();
        vec![describe(&router, &f, &settled[0])]
    } else {
        let command = RefCell::new(Some(command));
        let apply = Rc::clone(&router);
        let seen = Rc::clone(&f);
        let machine: Machine<'static, State, Message, Command, Sub<()>> = Machine {
            init: Box::new(move |_, _| {
                Step::new(
                    State { messages: vec![] },
                    vec![command.borrow_mut().take().unwrap()],
                )
            }),
            update: observe!(
                invoices::Router::update,
                router.as_ref(),
                move |state: &State, msg: &Message| {
                    let mut messages = state.messages.clone();
                    messages.push(describe(&apply, &seen, msg));
                    Step::new(State { messages }, vec![])
                }
            ),
            subscriptions: demlik_tea::core::subscriptions(|_: &State| vec![]),
        };
        let profile = if input.profile.as_deref() == Some("effect") {
            Profile::Effect
        } else {
            Profile::Promise
        };
        let options: Options<State, Message, Infallible, tool::ToolError> = Options {
            terminal: Some(Rc::new(|s| s.messages.len() == 1)),
            clock: Rc::new(|| 17.25),
            ..Options::new(profile)
        };
        let interpreter = observe!(
            invoices::Router::interpreter,
            Rc::clone(&router),
            Rc::new(Host { marker: "host" })
        );
        let live = observe!(
            demlik_tea::runtime::launch,
            machine,
            (),
            interpreter,
            NoSubscriptions::new(),
            options
        );
        tokio::time::timeout(Duration::from_secs(5), live.ready())
            .await
            .unwrap()
            .unwrap();
        let final_state = tokio::time::timeout(Duration::from_secs(5), live.done())
            .await
            .unwrap()
            .unwrap();
        let messages = final_state.messages.clone();
        live.stop().await;
        messages
    };
    obj([
        ("command", command_wire),
        ("messages", D::Array(messages)),
        ("inputCalls", D::Number(f.input_calls.get() as f64)),
        ("schemasSame", D::Bool(schemas_same)),
        (
            "trace",
            D::Array(f.trace.borrow().iter().map(|s| text(s.as_str())).collect()),
        ),
    ])
}
fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let local = tokio::task::LocalSet::new();
    for line in io::stdin().lock().lines() {
        let frame: Frame = serde_json::from_str(&line.unwrap()).unwrap();
        CALLS.with(|v| v.borrow_mut().clear());
        let view = runtime.block_on(local.run_until(execute(frame.input)));
        let calls = CALLS.with(|v| v.borrow().iter().map(|s| text(*s)).collect());
        println!(
            "{}",
            stringify_json(&obj([
                ("id", text(frame.id)),
                ("view", view),
                ("nativeTrace", D::Array(calls))
            ]))
            .unwrap()
        );
    }
}
