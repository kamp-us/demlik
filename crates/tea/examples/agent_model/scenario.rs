use demlik_tea::{
    PlainData, Tagged,
    agent::model::{BrainPorts, Llm, MessageLoader, Messages},
    command::Outcome,
    data::{JsText, JsonData},
    describe_error::{ErrorView, describe_error},
    llm_call::{self, CauseField, Config, LlmCall, LlmOutcome, Request, Schema},
    resilience::resilient_call::CallValue,
};
use serde::{Deserialize, Serialize};
use std::{
    cell::{Cell, RefCell},
    ops::AsyncFn,
    rc::{Rc, Weak},
};
pub type Calls = Rc<RefCell<Vec<&'static str>>>;
macro_rules! observe {($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{let value=$function($($arg),*);$calls.borrow_mut().push(stringify!($function));value}};}
macro_rules! observe_async {($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{let value=$function($($arg),*).await;$calls.borrow_mut().push(stringify!($function));value}};}
pub fn object(values: impl IntoIterator<Item = (&'static str, PlainData)>) -> PlainData {
    PlainData::Object(
        values
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}
pub fn string(value: impl Into<JsText>) -> PlainData {
    PlainData::String(value.into())
}
fn boolean(value: bool) -> PlainData {
    PlainData::Bool(value)
}
fn number(value: usize) -> PlainData {
    PlainData::Number(value as f64)
}
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Style {
    Factory,
    Plain,
    Wrapped,
}
#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FailureAt {
    Factory,
    Loader,
    Bind,
    Invoke,
    Parse1,
    Parse2,
}
fn one() -> usize {
    1
}
fn purpose() -> JsText {
    "turn".into()
}
fn reason() -> JsText {
    "original".into()
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Script {
    pub style: Style,
    #[serde(default)]
    pub no_loader: bool,
    #[serde(default)]
    pub failure: Option<FailureAt>,
    #[serde(default)]
    pub transform: bool,
    #[serde(default)]
    pub validate_model: bool,
    #[serde(default)]
    pub different_schema: bool,
    #[serde(default)]
    pub value: f64,
    #[serde(default)]
    pub model: Option<JsText>,
    #[serde(default = "purpose")]
    pub purpose: JsText,
    #[serde(default)]
    pub key: Option<JsText>,
    #[serde(default = "reason")]
    pub reason: JsText,
    #[serde(default = "one")]
    pub repeats: usize,
    #[serde(default)]
    pub undefined_cause: bool,
}
pub struct Token(pub Cell<u8>);
pub struct Payload(pub Rc<Token>);
pub struct Message {
    pub token: Rc<Token>,
}
pub struct Answer {
    pub value: f64,
    pub token: Rc<Token>,
}
pub struct OpaqueFailure {
    pub message: JsText,
    pub token: Rc<Token>,
}
/// Application-owned command-wire projection. The opaque original remains
/// available, while Source Error has no enumerable own JSON fields.
pub struct Cause(pub Rc<OpaqueFailure>);
impl Serialize for Cause {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        JsonData(&object([])).serialize(s)
    }
}
pub struct Context {
    pub script: Script,
    pub token: Rc<Token>,
    pub raw: Rc<Answer>,
    pub cause: Rc<Cause>,
    pub trace: RefCell<Vec<JsText>>,
    pub reads: Cell<usize>,
    pub parses: Cell<usize>,
    pub messages: Rc<Vec<Message>>,
    pub seen_messages: RefCell<Vec<Rc<Vec<Message>>>>,
    pub expected_request: RefCell<Weak<Request<JsText, Payload>>>,
    pub retained_calls: RefCell<Vec<Rc<Request<JsText, Payload>>>>,
    pub first: RefCell<Weak<Parser>>,
    pub model: RefCell<Weak<Client>>,
    pub bound_same: Cell<bool>,
    pub model_same: Cell<bool>,
    pub input_same: Cell<bool>,
    pub payload_same: Cell<bool>,
    pub factory_ids: RefCell<Vec<Option<JsText>>>,
    pub last_parsed: RefCell<Option<Rc<Answer>>>,
    pub first_parsed: RefCell<Option<Rc<Answer>>>,
}
impl Context {
    pub fn new(script: Script) -> Rc<Self> {
        let token = Rc::new(Token(Cell::new(1)));
        let raw = Rc::new(Answer {
            value: script.value,
            token: Rc::clone(&token),
        });
        let cause = Rc::new(Cause(Rc::new(OpaqueFailure {
            message: script.reason.clone(),
            token: Rc::clone(&token),
        })));
        Rc::new(Self {
            script,
            token: Rc::clone(&token),
            raw,
            cause,
            trace: RefCell::new(vec![]),
            reads: Cell::new(0),
            parses: Cell::new(0),
            messages: Rc::new(vec![Message { token }]),
            seen_messages: RefCell::new(vec![]),
            expected_request: RefCell::new(Weak::new()),
            retained_calls: RefCell::new(vec![]),
            first: RefCell::new(Weak::new()),
            model: RefCell::new(Weak::new()),
            bound_same: Cell::new(false),
            model_same: Cell::new(false),
            input_same: Cell::new(false),
            payload_same: Cell::new(false),
            factory_ids: RefCell::new(vec![]),
            last_parsed: RefCell::new(None),
            first_parsed: RefCell::new(None),
        })
    }
    pub fn record(&self, value: impl Into<JsText>) {
        self.trace.borrow_mut().push(value.into());
    }
    pub fn fail(&self) -> CallValue<Cause> {
        if self.script.undefined_cause {
            CallValue::Undefined
        } else {
            CallValue::shared(Rc::clone(&self.cause))
        }
    }
    pub fn invoke(
        &self,
        messages: Messages<'_, Message>,
        plain: bool,
    ) -> Result<Rc<Answer>, CallValue<Cause>> {
        self.record(if plain {
            if self.script.style == Style::Wrapped {
                "plain-sync-prefix"
            } else {
                "plain"
            }
        } else {
            "invoke"
        });
        let Messages::Shared(owner) = messages else {
            panic!("this application owns its message batches")
        };
        for message in owner.iter() {
            assert!(Rc::ptr_eq(&message.token, &self.token));
        }
        self.seen_messages.borrow_mut().push(owner);
        if self.script.failure == Some(FailureAt::Invoke) {
            Err(self.fail())
        } else {
            Ok(Rc::clone(&self.raw))
        }
    }
}
pub struct Parser {
    pub context: Rc<Context>,
    pub second: bool,
}
impl Schema for Parser {
    type Raw = Rc<Answer>;
    type Output = Rc<Answer>;
    type Error = Cause;
    fn parse(&self, raw: Rc<Answer>) -> Result<Rc<Answer>, CallValue<Cause>> {
        let ctx = &self.context;
        ctx.record(if self.second {
            "parse:second"
        } else {
            "parse:first"
        });
        ctx.parses.set(ctx.parses.get() + 1);
        if (ctx.script.failure == Some(FailureAt::Parse1) && ctx.parses.get() == 1)
            || (ctx.script.failure == Some(FailureAt::Parse2) && ctx.parses.get() == 2)
        {
            return Err(ctx.fail());
        }
        let parsed = if ctx.script.transform {
            Rc::new(Answer {
                value: raw.value + if self.second { 2.0 } else { 1.0 },
                token: Rc::clone(&raw.token),
            })
        } else {
            raw
        };
        if ctx.parses.get() == 1 {
            *ctx.first_parsed.borrow_mut() = Some(Rc::clone(&parsed))
        }
        *ctx.last_parsed.borrow_mut() = Some(Rc::clone(&parsed));
        Ok(parsed)
    }
}
pub type Knob = LlmCall<'static, JsText, Payload, Parser>;
pub type Command = llm_call::RunCmd<JsText, Payload, Rc<Answer>, Cause>;
pub fn knob(ctx: &Rc<Context>) -> Rc<Knob> {
    let first = Rc::new(Parser {
        context: Rc::clone(ctx),
        second: false,
    });
    let second = if ctx.script.different_schema {
        Rc::new(Parser {
            context: Rc::clone(ctx),
            second: true,
        })
    } else {
        Rc::clone(&first)
    };
    *ctx.first.borrow_mut() = Rc::downgrade(&first);
    let ctx = Rc::clone(ctx);
    Rc::new(LlmCall::new(
        Config::new(move |_| {
            ctx.reads.set(ctx.reads.get() + 1);
            ctx.record(format!("schema:{}", ctx.reads.get()));
            if ctx.reads.get() == 1 {
                Rc::clone(&first)
            } else {
                Rc::clone(&second)
            }
        }),
        |cause: &Cause| describe_error(ErrorView::ErrorMessage(&cause.0.message)),
    ))
}
pub struct Client(pub Rc<Context>);
impl Llm<Message, Parser> for Client {
    fn with_structured_output<'a>(
        &'a self,
        schema: &'a Parser,
    ) -> Result<
        impl for<'m> AsyncFn(Messages<'m, Message>) -> Result<Rc<Answer>, CallValue<Cause>> + 'a,
        CallValue<Cause>,
    > {
        let ctx = &self.0;
        ctx.record("bind");
        ctx.bound_same
            .set(std::ptr::eq(ctx.first.borrow().as_ptr(), schema));
        ctx.model_same
            .set(std::ptr::eq(ctx.model.borrow().as_ptr(), self));
        if ctx.script.failure == Some(FailureAt::Bind) {
            return Err(ctx.fail());
        }
        Ok(async move |messages: Messages<'_, Message>| {
            let raw = ctx.invoke(messages, false)?;
            if ctx.script.validate_model {
                schema.parse(raw)
            } else {
                Ok(raw)
            }
        })
    }
}
pub struct Loader(pub Rc<Context>);
impl MessageLoader<JsText, Payload, Message, Cause> for Loader {
    async fn load<'a>(
        &'a self,
        call: &'a Rc<Request<JsText, Payload>>,
    ) -> Result<Messages<'a, Message>, CallValue<Cause>>
    where
        Message: 'a,
    {
        let ctx = &self.0;
        ctx.record("loader");
        ctx.retained_calls.borrow_mut().push(Rc::clone(call));
        ctx.input_same.set(std::ptr::eq(
            ctx.expected_request.borrow().as_ptr(),
            call.as_ref(),
        ));
        ctx.payload_same
            .set(Rc::ptr_eq(&call.payload.0, &ctx.token));
        if ctx.script.failure == Some(FailureAt::Loader) {
            Err(ctx.fail())
        } else {
            Ok(Messages::Shared(Rc::clone(&ctx.messages)))
        }
    }
}
pub fn command(knob: &Knob, ctx: &Rc<Context>) -> Command {
    let input = Rc::new(Request::new(
        ctx.script.purpose.clone(),
        ctx.script.model.clone(),
        Payload(Rc::clone(&ctx.token)),
    ));
    *ctx.expected_request.borrow_mut() = Rc::downgrade(&input);
    knob.attempt_keyed(
        &knob.init(),
        ctx.script
            .key
            .clone()
            .unwrap_or_else(|| ctx.script.purpose.clone()),
        input,
        0.0,
    )
    .unwrap()
    .commands
    .pop()
    .unwrap()
}
pub fn answer(value: &Answer) -> PlainData {
    object([
        ("value", PlainData::Number(value.value)),
        (
            "opaque",
            object([("value", PlainData::Number(value.token.0.get() as f64))]),
        ),
    ])
}
pub fn outcome(ctx: &Context, out: &LlmOutcome<JsText, Rc<Answer>, Cause>) -> PlainData {
    match out {
        Outcome::Ok {
            value: CallValue::Shared(value),
        } => object([
            ("kind", string("ok")),
            ("key", string(value.key.clone())),
            ("purpose", string(value.purpose.clone())),
            ("output", answer(&value.output)),
            ("rawSame", boolean(Rc::ptr_eq(&value.output, &ctx.raw))),
            (
                "lastParsedSame",
                boolean(
                    ctx.last_parsed
                        .borrow()
                        .as_ref()
                        .is_some_and(|v| Rc::ptr_eq(v, &value.output)),
                ),
            ),
            (
                "firstParsedSame",
                boolean(
                    ctx.first_parsed
                        .borrow()
                        .as_ref()
                        .is_some_and(|v| Rc::ptr_eq(v, &value.output)),
                ),
            ),
            (
                "tokenSame",
                boolean(Rc::ptr_eq(&value.output.token, &ctx.token)),
            ),
        ]),
        Outcome::Err { error } => {
            let CauseField::Own(cause) = error.details.cause() else {
                panic!("own failure")
            };
            let same = match cause {
                CallValue::Shared(value) => {
                    Rc::ptr_eq(value, &ctx.cause)
                        && Rc::ptr_eq(&value.0, &ctx.cause.0)
                        && Rc::ptr_eq(&value.0.token, &ctx.token)
                }
                CallValue::Undefined => ctx.script.undefined_cause,
                CallValue::Missing => false,
            };
            let cause = if ctx.script.undefined_cause {
                object([("$value", string("undefined"))])
            } else {
                object([(
                    "error",
                    object([
                        ("name", string("Error")),
                        ("message", string(ctx.cause.0.message.clone())),
                    ]),
                )])
            };
            object([
                ("kind", string("error")),
                ("tag", string("port_rejected")),
                ("causeSame", boolean(same)),
                ("cause", cause),
            ])
        }
        _ => panic!("typed result"),
    }
}
pub fn snapshot(ctx: &Context, outcomes: Vec<PlainData>) -> PlainData {
    let seen = ctx.seen_messages.borrow();
    let same = seen
        .iter()
        .map(|messages| boolean(Rc::ptr_eq(messages, &ctx.messages)))
        .collect();
    let fresh = seen
        .iter()
        .enumerate()
        .all(|(i, one)| seen.iter().skip(i + 1).all(|two| !Rc::ptr_eq(one, two)));
    object([
        (
            "trace",
            PlainData::Array(ctx.trace.borrow().iter().cloned().map(string).collect()),
        ),
        ("parses", number(ctx.parses.get())),
        ("schemaReads", number(ctx.reads.get())),
        (
            "boundSame",
            if ctx.script.style == Style::Factory {
                boolean(ctx.bound_same.get())
            } else {
                PlainData::Null
            },
        ),
        (
            "modelSame",
            if ctx.script.style == Style::Factory {
                boolean(ctx.model_same.get())
            } else {
                PlainData::Null
            },
        ),
        ("inputSame", boolean(ctx.input_same.get())),
        ("payloadSame", boolean(ctx.payload_same.get())),
        (
            "retainedCalls",
            PlainData::Array(
                ctx.retained_calls
                    .borrow()
                    .iter()
                    .map(|call| {
                        object([
                            (
                                "inputSame",
                                boolean(std::ptr::eq(
                                    ctx.expected_request.borrow().as_ptr(),
                                    call.as_ref(),
                                )),
                            ),
                            (
                                "payloadSame",
                                boolean(Rc::ptr_eq(&call.payload.0, &ctx.token)),
                            ),
                            ("value", PlainData::Number(call.payload.0.0.get() as f64)),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("messagesSame", PlainData::Array(same)),
        (
            "defaultEmpty",
            if ctx.script.no_loader {
                boolean(seen.iter().all(|v| v.is_empty()))
            } else {
                PlainData::Null
            },
        ),
        (
            "defaultFresh",
            if ctx.script.no_loader {
                boolean(fresh)
            } else {
                PlainData::Null
            },
        ),
        (
            "factoryModels",
            PlainData::Array(
                ctx.factory_ids
                    .borrow()
                    .iter()
                    .map(|id| id.as_ref().map_or(PlainData::Null, |id| string(id.clone())))
                    .collect(),
            ),
        ),
        ("outcomes", PlainData::Array(outcomes)),
    ])
}
async fn run_port<F: demlik_tea::agent::model::ModelFactory<Message, Parser>>(
    ctx: &Rc<Context>,
    llm: &Knob,
    cmd: &Command,
    model: &F,
    calls: &Calls,
) -> Vec<PlainData> {
    let loader = Loader(Rc::clone(ctx));
    let mut outcomes = vec![];
    if ctx.script.no_loader {
        let handler = observe!(
            calls,
            demlik_tea::agent::model::brain_handler,
            llm,
            BrainPorts::new(model)
        );
        for _ in 0..ctx.script.repeats {
            let out = observe_async!(
                calls,
                demlik_tea::agent::model::BrainHandler::handle,
                &handler,
                cmd
            )
            .unwrap();
            outcomes.push(outcome(ctx, &out));
        }
    } else {
        let ports = observe!(
            calls,
            demlik_tea::agent::model::BrainPorts::with_loader,
            BrainPorts::new(model),
            &loader
        );
        let handler = observe!(calls, demlik_tea::agent::model::brain_handler, llm, ports);
        for _ in 0..ctx.script.repeats {
            let out = observe_async!(
                calls,
                demlik_tea::agent::model::BrainHandler::handle,
                &handler,
                cmd
            )
            .unwrap();
            outcomes.push(outcome(ctx, &out));
        }
    }
    outcomes
}
pub async fn run(script: Script, calls: &Calls) -> PlainData {
    let ctx = Context::new(script);
    let llm = knob(&ctx);
    let cmd = command(&llm, &ctx);
    let client = Rc::new(Client(Rc::clone(&ctx)));
    *ctx.model.borrow_mut() = Rc::downgrade(&client);
    let state = Rc::clone(&ctx);
    let outcomes = match ctx.script.style {
        Style::Factory => {
            let model = observe!(
                calls,
                demlik_tea::agent::model::model_factory,
                move |id: Option<&JsText>| {
                    state.record("factory");
                    state.factory_ids.borrow_mut().push(id.cloned());
                    if state.script.failure == Some(FailureAt::Factory) {
                        Err(state.fail())
                    } else {
                        Ok(Rc::clone(&client))
                    }
                }
            );
            run_port(&ctx, &llm, &cmd, &model, calls).await
        }
        Style::Plain => {
            let model = observe!(
                calls,
                demlik_tea::agent::model::plain_model,
                async move |messages: Messages<'_, Message>| state.invoke(messages, true)
            );
            run_port(&ctx, &llm, &cmd, &model, calls).await
        }
        Style::Wrapped => {
            let model = observe!(
                calls,
                demlik_tea::agent::model::plain_model,
                move |messages: Messages<'_, Message>| std::future::ready(
                    state.invoke(messages, true)
                )
            );
            run_port(&ctx, &llm, &cmd, &model, calls).await
        }
    };
    snapshot(&ctx, outcomes)
}

pub async fn input_boundary(variant: &str, calls: &Calls) -> PlainData {
    use demlik_tea::{llm_call::LlmCallError, resilience::resilient_call::RunInput};
    let script: Script = serde_json::from_str(r#"{"style":"plain","noLoader":true}"#).unwrap();
    let ctx = Context::new(script);
    let llm = knob(&ctx);
    let state = Rc::clone(&ctx);
    let model = observe!(
        calls,
        demlik_tea::agent::model::plain_model,
        async move |messages: Messages<'_, Message>| state.invoke(messages, true)
    );
    let handler = observe!(
        calls,
        demlik_tea::agent::model::brain_handler,
        llm.as_ref(),
        BrainPorts::new(&model)
    );
    let input = match variant {
        "missing" => CallValue::Missing,
        "undefined" => CallValue::Undefined,
        _ => panic!("validated variant"),
    };
    let cmd = llm.run().from_record(RunInput {
        key: "turn".into(),
        input,
    });
    match observe_async!(
        calls,
        demlik_tea::agent::model::BrainHandler::handle,
        &handler,
        &cmd
    ) {
        Ok(Outcome::Err { error }) => {
            let wire = demlik_tea::data::plain_data(&Outcome::<(), _>::err(&error)).unwrap();
            let CauseField::AccessError(cause) = error.details.cause() else {
                panic!("the input error must retain its library cause")
            };
            object([
                ("outcome", string("Err")),
                ("tag", string(error.tag())),
                (
                    "cause",
                    object([(
                        "error",
                        object([
                            ("name", string(cause.name)),
                            ("message", string(cause.message.clone())),
                        ]),
                    )]),
                ),
                ("wire", wire),
                (
                    "trace",
                    PlainData::Array(ctx.trace.borrow().iter().cloned().map(string).collect()),
                ),
            ])
        }
        Err(LlmCallError::MissingInput { command }) => object([
            (
                "refusal",
                object([
                    ("kind", string("MissingInput")),
                    ("command", string(command)),
                ]),
            ),
            (
                "trace",
                PlainData::Array(ctx.trace.borrow().iter().cloned().map(string).collect()),
            ),
        ]),
        _ => panic!("unexpected model input-boundary result"),
    }
}
