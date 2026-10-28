//! Invoice fixture over the public tool declaration, router, and real actor.
use demlik_tea::{
    Machine, PlainData as D, Step, Sub, Tagged,
    agent::{
        content::{ContentPart, Parts, TextPart},
        tool::{self, ErrorFamily, Raised, ToolContext, ToolFailure, ToolSpec},
        types::ToolCall,
    },
    command::{
        CmdDef, CommandEdge, CommandFamily, Failure, Issue, Outcome, SchemaError, Settlement,
    },
    data::{JsText, decode_json, plain_data, stringify_json},
    llm_call::Schema,
    resilience::resilient_call::CallValue,
    retry_backoff::{BackoffCurve, CountBound, Jitter, RetryPolicy},
    runtime::{NoSubscriptions, Options, Profile},
};
use serde::{Deserialize, Serialize};
use std::{
    cell::RefCell,
    convert::Infallible,
    io::{self, BufRead},
    rc::Rc,
    time::Duration,
};
demlik_tea::tool_router! { pub mod invoices { Read(read), Check(check) } }
demlik_tea::tool_router! {mod empty_invoices {}}
macro_rules! observe {($f:path $(,$arg:expr)* $(,)?)=>{{let v=$f($($arg),*);CALLS.with(|c|c.borrow_mut().push(stringify!($f)));v}};}
thread_local! {static CALLS:RefCell<Vec<&'static str>>=const{RefCell::new(Vec::new())};}
#[derive(Deserialize)]
struct Frame {
    id: String,
    input: Input,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    mode: String,
    name: Option<String>,
    args: Option<D>,
    scenario: Option<String>,
    profile: Option<String>,
    declaration: Option<String>,
    #[serde(default)]
    resilience: bool,
}
fn obj(fields: impl IntoIterator<Item = (&'static str, D)>) -> D {
    D::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}
fn text(s: impl Into<JsText>) -> D {
    D::String(s.into())
}
fn arr(values: impl IntoIterator<Item = D>) -> D {
    D::Array(values.into_iter().collect())
}
fn field<'a>(v: &'a D, k: &str) -> Option<&'a D> {
    if let D::Object(v) = v { v.get(k) } else { None }
}
fn string(v: &D) -> Option<&str> {
    if let D::String(v) = v {
        v.as_utf8()
    } else {
        None
    }
}
fn number(v: &D) -> Option<f64> {
    if let D::Number(v) = v { Some(*v) } else { None }
}
fn wire<T: Serialize>(v: &T) -> D {
    decode_json(&stringify_json(&plain_data(v).unwrap()).unwrap()).unwrap()
}
fn optional(v: Option<bool>) -> D {
    v.map_or(D::Null, D::Bool)
}
#[derive(Default)]
struct Observations {
    trace: RefCell<Vec<D>>,
    parsed: RefCell<Option<Rc<D>>>,
    returned: RefCell<Option<Rc<D>>>,
    raised: RefCell<Option<Rc<D>>>,
}
struct Fixture {
    scenario: String,
    seen: Observations,
    parts: Parts,
}
impl Fixture {
    fn push(&self, v: impl IntoIterator<Item = D>) {
        self.seen.trace.borrow_mut().push(arr(v));
    }
}
#[derive(Clone, Copy)]
enum Kind {
    ReadInput,
    ReadOutput,
    CheckInput,
    CheckOutput,
}
struct Parser {
    fixture: Rc<Fixture>,
    kind: Kind,
}
impl Schema for Parser {
    type Raw = Rc<D>;
    type Output = Rc<D>;
    type Error = SchemaError;
    fn parse(&self, raw: Rc<D>) -> Result<Rc<D>, CallValue<SchemaError>> {
        let f = &self.fixture;
        let (phase, name) = match self.kind {
            Kind::ReadInput => ("input", "read"),
            Kind::ReadOutput => ("output", "read"),
            Kind::CheckInput => ("input", "check"),
            Kind::CheckOutput => ("output", "check"),
        };
        f.push([text(phase), text(name)]);
        let fail = |path, message| {
            Err(CallValue::value(SchemaError::Issues(vec![Issue::new(
                path, message,
            )])))
        };
        match self.kind {
            Kind::ReadInput => {
                if f.scenario == "async-input" {
                    return Err(CallValue::value(SchemaError::Async));
                }
                let Some(invoice) = field(&raw, "invoice").and_then(string) else {
                    return fail("invoice", "Expected invoice string");
                };
                let value = if f.scenario == "identity" {
                    raw
                } else {
                    Rc::new(obj([("invoice", text(invoice.trim().to_uppercase()))]))
                };
                f.seen.parsed.replace(Some(Rc::clone(&value)));
                Ok(value)
            }
            Kind::ReadOutput => {
                if f.scenario == "async-output" {
                    return Err(CallValue::value(SchemaError::Async));
                }
                let Some(total) = field(&raw, "total").and_then(number).filter(|v| *v >= 0.0)
                else {
                    return fail("total", "Expected nonnegative total");
                };
                let Some(currency) = field(&raw, "currency").and_then(string) else {
                    return fail("total", "Expected nonnegative total");
                };
                Ok(if f.scenario == "identity" {
                    raw
                } else {
                    Rc::new(obj([
                        ("total", D::Number(total)),
                        ("currency", text(currency)),
                    ]))
                })
            }
            Kind::CheckInput => {
                let Some(D::Array(lines)) = field(&raw, "lines") else {
                    return fail("lines", "Expected numeric lines");
                };
                if !lines.iter().all(|v| number(v).is_some()) {
                    return fail("lines", "Expected numeric lines");
                }
                let expected = field(&raw, "expected").and_then(number).unwrap_or(15.0);
                Ok(Rc::new(obj([
                    ("lines", D::Array(lines.clone())),
                    ("expected", D::Number(expected)),
                ])))
            }
            Kind::CheckOutput => {
                if !matches!(field(&raw, "valid"), Some(D::Bool(_)))
                    || field(&raw, "sum").and_then(number).is_none()
                {
                    return fail("", "Expected check result");
                }
                Ok(Rc::new(obj([
                    ("valid", field(&raw, "valid").unwrap().clone()),
                    ("sum", field(&raw, "sum").unwrap().clone()),
                ])))
            }
        }
    }
}
#[derive(Serialize)]
#[serde(transparent)]
struct Declared(Rc<D>);
impl Tagged for Declared {
    fn tag(&self) -> &str {
        field(&self.0, "_tag").and_then(string).unwrap()
    }
}
struct Cause {
    message: JsText,
}
#[derive(Clone, Copy)]
struct Host {
    bias: f64,
}
type Read = tool::ToolDef<'static, D, D, D, Parser, Parser, Declared, Cause, Host, Rc<Cause>>;
type Check = tool::ToolDef<'static, D, D, D, Parser, Parser, Declared, Cause, Host, Infallible>;
type Router = invoices::Router<Read, Check>;
type Command = invoices::Commands<Read, Check>;
type Message = <Command as CommandFamily>::Msg;
fn make(input: &Input) -> (Rc<Router>, Rc<Fixture>, Rc<Parser>, Rc<Parser>) {
    let f = Rc::new(Fixture {
        scenario: input.scenario.clone().unwrap_or_else(|| "success".into()),
        seen: Observations::default(),
        parts: Rc::new(RefCell::new(vec![ContentPart::Text(Rc::new(TextPart {
            text: "invoice media".into(),
        }))])),
    });
    let input_schema = Rc::new(Parser {
        fixture: Rc::clone(&f),
        kind: Kind::ReadInput,
    });
    let output_schema = Rc::new(Parser {
        fixture: Rc::clone(&f),
        kind: Kind::ReadOutput,
    });
    let content = Rc::clone(&f);
    let handler = Rc::clone(&f);
    let spec = ToolSpec::new(
        Rc::clone(&input_schema),
        Rc::clone(&output_schema),
        ErrorFamily::new(["unavailable"], |e: &Declared| Ok(e.0.as_ref().clone())),
    )
    .description("Read the invoice total")
    .raised::<Cause>()
    .try_content(move |v: &Rc<D>| {
        content.push([text("content"), field(v, "total").unwrap().clone()]);
        if content.scenario == "content-error" {
            Err(Rc::new(Cause {
                message: "content failed".into(),
            }))
        } else {
            Ok(Rc::clone(&content.parts))
        }
    });
    let spec = if input.resilience {
        spec.resilience(tool_resilience())
    } else {
        spec
    };
    let read = observe!(
        demlik_tea::agent::tool::tool,
        "read_invoice",
        spec,
        move |args: &Rc<D>, ctx: ToolContext<'_, Host>| {
            let f = Rc::clone(&handler);
            Box::pin(async move {
                let same = f
                    .seen
                    .parsed
                    .borrow()
                    .as_ref()
                    .is_some_and(|p| Rc::ptr_eq(p, args));
                f.push([
                    text("handler"),
                    text("read"),
                    field(args, "invoice").unwrap().clone(),
                    D::Number(ctx.host.bias),
                    D::Bool(same),
                ]);
                match f.scenario.as_str() {
                    "declared-return" | "declared-raise" => {
                        let error = Rc::new(obj([
                            ("_tag", text("unavailable")),
                            ("via", text(f.scenario.clone())),
                            ("kind", text("ok")),
                            ("reason", text("payload")),
                        ]));
                        f.seen.raised.replace(Some(Rc::clone(&error)));
                        let error = Rc::new(Declared(error));
                        if f.scenario == "declared-raise" {
                            Err(Raised::Declared(error))
                        } else {
                            Ok(Outcome::err(error))
                        }
                    }
                    "error" => Err(Raised::Error {
                        message: "invoice offline".into(),
                        cause: Rc::new(Cause {
                            message: "invoice offline".into(),
                        }),
                    }),
                    "object" => Err(Raised::Value(Rc::new(obj([(
                        "message",
                        text("pretender"),
                    )])))),
                    "string" => Err(Raised::Value(Rc::new(text("invoice text")))),
                    "null" => Err(Raised::Value(Rc::new(D::Null))),
                    "undefined" => Err(Raised::Value(Rc::new(D::Undefined))),
                    _ => {
                        let value = Rc::new(obj([
                            (
                                "total",
                                D::Number(if f.scenario == "negative-output" {
                                    -1.0
                                } else {
                                    15.0
                                }),
                            ),
                            ("currency", text("USD")),
                            ("extra", text("stripped")),
                        ]));
                        f.seen.returned.replace(Some(Rc::clone(&value)));
                        Ok(Outcome::ok(value))
                    }
                }
            })
        }
    )
    .unwrap();
    let check_f = Rc::clone(&f);
    let check = observe!(
        demlik_tea::agent::tool::tool,
        "check_invoice",
        ToolSpec::new(
            Rc::new(Parser {
                fixture: Rc::clone(&f),
                kind: Kind::CheckInput
            }),
            Rc::new(Parser {
                fixture: Rc::clone(&f),
                kind: Kind::CheckOutput
            }),
            ErrorFamily::new(std::iter::empty::<String>(), |e: &Declared| Ok(e
                .0
                .as_ref()
                .clone()))
        )
        .description("Check invoice lines")
        .raised::<Cause>(),
        move |args: &Rc<D>, ctx: ToolContext<'_, Host>| {
            let f = Rc::clone(&check_f);
            Box::pin(async move {
                let expected = field(args, "expected").and_then(number).unwrap();
                f.push([
                    text("handler"),
                    text("check"),
                    D::Number(expected),
                    D::Number(ctx.host.bias),
                ]);
                let D::Array(lines) = field(args, "lines").unwrap() else {
                    unreachable!()
                };
                let sum = lines.iter().map(|v| number(v).unwrap()).sum::<f64>();
                Ok(Outcome::ok(Rc::new(obj([
                    ("valid", D::Bool(sum == expected)),
                    ("sum", D::Number(sum)),
                ]))))
            })
        }
    )
    .unwrap();
    (
        Rc::new(observe!(invoices::Router::new, read, check).unwrap()),
        f,
        input_schema,
        output_schema,
    )
}
fn tool_resilience() -> demlik_tea::agent::ToolResilience {
    demlik_tea::agent::ToolResilience::default()
        .timeout_ms(50.0)
        .retry(RetryPolicy {
            curve: BackoffCurve {
                base_ms: 10.0,
                factor: 2.0,
                cap_ms: 100.0,
                jitter: Jitter::None,
            },
            budget: CountBound { max_attempts: 3.0 },
        })
}
fn details(e: &tool::ToolError) -> D {
    obj([("name", text(e.name())), ("message", text(e.to_string()))])
}
fn fail(phase: &str, error: D, captured: &D, f: &Fixture) -> D {
    let D::Object(mut fields) = captured.clone() else {
        unreachable!()
    };
    fields.insert("error".into(), error);
    fields.insert("phase".into(), text(phase));
    fields.insert("trace".into(), arr(f.seen.trace.borrow().clone()));
    D::Object(fields)
}
async fn execute(input: Input) -> D {
    if input.mode == "empty" {
        return empty_view(&input).await;
    }
    let (router, f, args_schema, _ok_schema) = make(&input);
    let mut captured = obj([]);
    let host = Host { bias: 1.0 };
    if input.declaration.as_deref() == Some("duplicate") {
        let error = match observe!(
            invoices::Router::new,
            Rc::clone(router.read()),
            Rc::clone(router.read())
        ) {
            Err(e) => e,
            Ok(_) => panic!("duplicate accepted"),
        };
        return fail("declaration", details(&error), &captured, &f);
    }
    if input.declaration.as_deref() == Some("reserved") {
        let name = input.name.as_ref().unwrap();
        let result = observe!(
            demlik_tea::agent::tool::tool,
            name.clone(),
            ToolSpec::new(
                Rc::clone(&args_schema),
                Rc::clone(&_ok_schema),
                ErrorFamily::new(std::iter::empty::<String>(), |e: &Declared| Ok(e
                    .0
                    .as_ref()
                    .clone()))
            ),
            |_: &Rc<D>, _: ToolContext<'_, Host>| Box::pin(async {
                Ok(Outcome::ok(Rc::new(obj([
                    ("total", D::Number(0.0)),
                    ("currency", text("USD")),
                ]))))
            })
        );
        let error = match result {
            Err(e) => e,
            Ok(_) => panic!("reserved name accepted"),
        };
        return fail("declaration", details(&error), &captured, &f);
    }
    let call = ToolCall {
        call_id: "invoice-call".into(),
        name: input.name.as_deref().unwrap_or("read_invoice").into(),
        args: Rc::new(
            input
                .args
                .unwrap_or_else(|| obj([("invoice", text("inv-17"))])),
        ),
    };
    if input.mode == "runtime" {
        let scenario = f.scenario.clone();
        return runtime_view(
            input.profile.as_deref().unwrap_or("promise"),
            &scenario,
            router,
            f,
            call,
        )
        .await;
    }
    let command = match observe!(invoices::Router::tool_of, router.as_ref(), &call) {
        Ok(c) => c,
        Err(e) => return fail("route", details(&e), &captured, &f),
    };
    let args_same = match &command {
        Command::Read(c) => Some(Rc::ptr_eq(&c.cmd().input().args, &call.args)),
        _ => None,
    };
    let D::Object(fields) = &mut captured else {
        unreachable!()
    };
    fields.insert("command".into(), wire(&command));
    let returned = match observe!(
        invoices::Router::interpret,
        router.as_ref(),
        &command,
        ToolContext::bare(&host)
    )
    .await
    {
        Ok(v) => v,
        Err(e) => return fail("interpret", details(&e), &captured, &f),
    };
    let D::Object(fields) = &mut captured else {
        unreachable!()
    };
    fields.insert("returned".into(), wire(&returned));
    let mut messages = match observe!(
        demlik_tea::command::CommandFamily::settle_in,
        command,
        returned,
        &CommandEdge::new(|| 17.25)
    ) {
        Ok(v) => v,
        Err(e) => return fail("settle", details(&e.into()), &captured, &f),
    };
    let settled = messages.remove(0);
    let D::Object(fields) = &mut captured else {
        unreachable!()
    };
    fields.insert("settled".into(), wire(&settled));
    let outcome = match observe!(invoices::Router::outcome_of, router.as_ref(), &settled) {
        Ok(v) => v,
        Err(e) => return fail("settle", details(&e.into()), &captured, &f),
    };
    let D::Object(fields) = &mut captured else {
        unreachable!()
    };
    fields.insert("outcome".into(), wire(&outcome));
    let parts = match &outcome {
        None => None,
        Some(out) => match observe!(
            invoices::Router::parts_of,
            router.as_ref(),
            &call,
            &out.outcome
        ) {
            Ok(v) => v,
            Err(invoices::ContentErrors::Read(e)) => {
                return fail(
                    "content",
                    obj([
                        ("name", text("Error")),
                        ("message", text(e.message.clone())),
                    ]),
                    &captured,
                    &f,
                );
            }
            Err(invoices::ContentErrors::Check(e)) => match e {},
        },
    };
    let (returned_same, failure_same) = match &settled {
        invoices::Messages::Read(m) => match m.outcome() {
            Settlement::Ok(v) => (
                Some(
                    f.seen
                        .returned
                        .borrow()
                        .as_ref()
                        .is_some_and(|raw| Rc::ptr_eq(v, raw)),
                ),
                None,
            ),
            Settlement::Err(Failure::Declared(ToolFailure::Declared(e))) => (
                None,
                Some(
                    f.seen
                        .raised
                        .borrow()
                        .as_ref()
                        .is_some_and(|raw| Rc::ptr_eq(&e.0, raw)),
                ),
            ),
            _ => (None, None),
        },
        _ => (None, None),
    };
    let own = obj([
        (
            "inputSchemaSame",
            D::Bool(Rc::ptr_eq(router.read().input_schema(), &args_schema)),
        ),
        ("argsSame", optional(args_same)),
        ("returnedSame", optional(returned_same)),
        ("failureSame", optional(failure_same)),
        (
            "partsSame",
            optional(parts.as_ref().map(|p| Rc::ptr_eq(p, &f.parts))),
        ),
        (
            "elementSame",
            optional(
                parts
                    .as_ref()
                    .map(|p| p.borrow()[0].same_identity(&f.parts.borrow()[0])),
            ),
        ),
    ]);
    let foreign = if f.scenario == "foreign-name" {
        let def = CmdDef::<tool::SignatureOf<Read>>::named("foreign");
        let msg = invoices::Messages::Read(def.ok(
            def.from_record(tool::ToolInput {
                call_id: "foreign".into(),
                args: Rc::new(obj([])),
            }),
            Rc::new(obj([])),
            None,
        ));
        wire(&observe!(invoices::Router::outcome_of, router.as_ref(), &msg).unwrap())
    } else {
        D::Null
    };
    let forged = if f.scenario == "forged-pure" {
        let def = CmdDef::<tool::SignatureOf<Read>>::named("read_invoice");
        let msg = invoices::Messages::Read(def.ok(
            def.from_record(tool::ToolInput {
                call_id: "forged".into(),
                args: Rc::new(obj([("invoice", text("x"))])),
            }),
            Rc::new(obj([("total", D::Number(99.0)), ("currency", text("USD"))])),
            Some(999.0),
        ));
        wire(&observe!(invoices::Router::outcome_of, router.as_ref(), &msg).unwrap())
    } else {
        D::Null
    };
    let D::Object(mut fields) = captured else {
        unreachable!()
    };
    fields.insert("parts".into(), wire(&parts));
    fields.insert("own".into(), own);
    fields.insert(
        "resilience".into(),
        wire(&observe!(
            invoices::Router::resilience_of,
            router.as_ref(),
            &call
        )),
    );
    fields.insert("foreign".into(), foreign);
    fields.insert("forged".into(), forged);
    fields.insert("trace".into(), arr(f.seen.trace.borrow().clone()));
    D::Object(fields)
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
async fn runtime_view(
    profile: &str,
    scenario: &str,
    router: Rc<Router>,
    f: Rc<Fixture>,
    call: ToolCall<D>,
) -> D {
    let calls = if scenario == "workflow" {
        vec![
            call,
            ToolCall {
                call_id: "check".into(),
                name: "check_invoice".into(),
                args: Rc::new(obj([
                    ("lines", arr([D::Number(4.5), D::Number(10.5)])),
                    ("expected", D::Number(15.0)),
                ])),
            },
            ToolCall {
                call_id: "unknown".into(),
                name: "none".into(),
                args: Rc::new(obj([])),
            },
            ToolCall {
                call_id: "bad".into(),
                name: "check_invoice".into(),
                args: Rc::new(obj([("lines", text("bad"))])),
            },
        ]
    } else {
        vec![call]
    };
    let count = calls.len();
    let init_router = Rc::clone(&router);
    let apply_router = Rc::clone(&router);
    let machine: Machine<'static, State, Message, Command, Sub<()>> = Machine {
        init: Box::new(move |_: Option<State>, _: &()| {
            Step::new(
                State { messages: vec![] },
                calls
                    .iter()
                    .map(|call| {
                        observe!(invoices::Router::tool_of, init_router.as_ref(), call).unwrap()
                    })
                    .collect(),
            )
        }),
        update: observe!(
            invoices::Router::update,
            router.as_ref(),
            move |state: &State, message: &Message| {
                let mut messages = state.messages.clone();
                messages.push(obj([
                    ("message", wire(message)),
                    (
                        "outcome",
                        wire(
                            &observe!(invoices::Router::outcome_of, apply_router.as_ref(), message)
                                .unwrap(),
                        ),
                    ),
                ]));
                Step::new(State { messages }, vec![])
            }
        ),
        subscriptions: demlik_tea::core::subscriptions(|_: &State| vec![]),
    };
    let options: Options<State, Message, Infallible, tool::ToolError> = Options {
        profile: if profile == "effect" {
            Profile::Effect
        } else {
            Profile::Promise
        },
        terminal: Some(Rc::new(move |s| s.messages.len() == count)),
        clock: Rc::new(|| 17.25),
        ..Options::new(if profile == "effect" {
            Profile::Effect
        } else {
            Profile::Promise
        })
    };
    let interpreter = observe!(
        invoices::Router::interpreter,
        Rc::clone(&router),
        Rc::new(Host { bias: 1.0 })
    );
    let live = observe!(
        demlik_tea::runtime::launch,
        machine,
        (),
        interpreter,
        NoSubscriptions::new(),
        options
    );
    let ready = tokio::time::timeout(Duration::from_secs(5), live.ready())
        .await
        .unwrap();
    if let Err(e) = ready {
        return obj([("error", text(e.name()))]);
    }
    let state = tokio::time::timeout(Duration::from_secs(5), live.done())
        .await
        .unwrap()
        .unwrap();
    let result = obj([
        ("state", wire(state.as_ref())),
        ("trace", arr(f.seen.trace.borrow().clone())),
    ]);
    live.stop().await;
    result
}
async fn empty_view(input: &Input) -> D {
    let router = Rc::new(observe!(empty_invoices::Router::new).unwrap());
    let call = ToolCall {
        call_id: "empty-call".into(),
        name: "read_invoice".into(),
        args: Rc::new(obj([("invoice", text("INV-17"))])),
    };
    let command = observe!(empty_invoices::Router::tool_of, router.as_ref(), &call).unwrap();
    let defs = arr([text(command.tag())]);
    if input.scenario.as_deref().unwrap_or("edge") == "edge" {
        let returned = observe!(empty_invoices::Router::interpret, router.as_ref(), &command)
            .await
            .unwrap();
        let returned_wire = wire(&returned);
        let command_wire = wire(&command);
        let message = observe!(
            demlik_tea::command::CommandFamily::settle_in,
            command,
            returned,
            &CommandEdge::new(|| 17.25)
        )
        .unwrap()
        .remove(0);
        let outcome = observe!(
            empty_invoices::Router::outcome_of,
            router.as_ref(),
            &message
        )
        .unwrap()
        .unwrap();
        return obj([
            ("defs", defs),
            ("command", command_wire),
            ("returned", returned_wire),
            ("settled", wire(&message)),
            ("outcome", wire(&outcome)),
            (
                "parts",
                wire(
                    &observe!(
                        empty_invoices::Router::parts_of,
                        router.as_ref(),
                        &call,
                        &outcome.outcome
                    )
                    .unwrap(),
                ),
            ),
            (
                "resilience",
                wire(&observe!(
                    empty_invoices::Router::resilience_of,
                    router.as_ref(),
                    &call
                )),
            ),
        ]);
    }
    let init = Rc::clone(&router);
    let update = Rc::clone(&router);
    let machine: Machine<
        'static,
        State,
        empty_invoices::Messages,
        empty_invoices::Commands,
        Sub<()>,
    > = Machine {
        init: Box::new(move |_, _| {
            Step::new(
                State { messages: vec![] },
                vec![observe!(empty_invoices::Router::tool_of, init.as_ref(), &call).unwrap()],
            )
        }),
        update: observe!(
            empty_invoices::Router::update,
            router.as_ref(),
            move |state: &State, message| {
                let mut messages = state.messages.clone();
                messages.push(obj([
                    ("message", wire(message)),
                    (
                        "outcome",
                        wire(
                            &observe!(empty_invoices::Router::outcome_of, update.as_ref(), message)
                                .unwrap(),
                        ),
                    ),
                ]));
                Step::new(State { messages }, vec![])
            }
        ),
        subscriptions: demlik_tea::core::subscriptions(|_: &State| vec![]),
    };
    let mut options: Options<State, empty_invoices::Messages, Infallible, tool::ToolError> =
        Options::new(if input.profile.as_deref() == Some("effect") {
            Profile::Effect
        } else {
            Profile::Promise
        });
    options.clock = Rc::new(|| 17.25);
    options.terminal = Some(Rc::new(|s: &State| s.messages.len() == 1));
    let live = observe!(
        demlik_tea::runtime::launch,
        machine,
        (),
        observe!(empty_invoices::Router::interpreter, router.as_ref()),
        NoSubscriptions::new(),
        options
    );
    live.ready().await.unwrap();
    let state = live.done().await.unwrap();
    live.stop().await;
    obj([("defs", defs), ("state", wire(state.as_ref()))])
}
fn main() {
    let runner = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let local = tokio::task::LocalSet::new();
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        let frame: Frame = match serde_json::from_str(&line) {
            Ok(f) => f,
            Err(e) => {
                println!("{}", serde_json::json!({"id":null,"error":e.to_string()}));
                continue;
            }
        };
        CALLS.with(|c| c.borrow_mut().clear());
        let view = runner.block_on(local.run_until(execute(frame.input)));
        let calls = CALLS.with(|c| c.borrow().clone());
        println!(
            "{}",
            stringify_json(&obj([
                ("id", text(frame.id)),
                ("view", view),
                ("nativeTrace", arr(calls.into_iter().map(text)))
            ]))
            .unwrap()
        );
    }
}
