//! The parsed constructor accepts opaque borrowed data and retains its owners.
use demlik_tea::{
    PlainData, Tagged,
    agent::tool::{
        ErrorFamily, ToolContext, ToolDefinition, ToolFailure, ToolInput, ToolSpec, tool,
    },
    command::{CommandEdge, CommandFamily, Failure, Issue, Outcome, SchemaError, Settlement},
    llm_call::Schema,
    resilience::resilient_call::CallValue,
};
use std::{cell::Cell, marker::PhantomData, rc::Rc};

demlik_tea::tool_router! { mod invoices { Read(read), Check(check) } }
struct Raw<'a>(&'a str);
struct Parsed<'a>(&'a str);
struct Invoice<'a>(&'a str, Rc<Cell<u32>>);
struct Cause<'a>(&'a str, Rc<Cell<u32>>);
impl Tagged for Cause<'_> {
    fn tag(&self) -> &str {
        "unavailable"
    }
}
struct Input<'a> {
    calls: Rc<Cell<u32>>,
    marker: PhantomData<&'a ()>,
}
impl<'a> Schema for Input<'a> {
    type Raw = Rc<Raw<'a>>;
    type Output = Rc<Parsed<'a>>;
    type Error = SchemaError;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        self.calls.set(self.calls.get() + 1);
        Err(CallValue::value(SchemaError::Issues(vec![Issue::new(
            "", raw.0,
        )])))
    }
}
struct Output<'a>(PhantomData<&'a ()>);
impl<'a> Schema for Output<'a> {
    type Raw = Rc<Invoice<'a>>;
    type Output = Rc<Invoice<'a>>;
    type Error = SchemaError;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        Ok(raw)
    }
}
struct Host<'a> {
    args: Rc<Parsed<'a>>,
    result: Rc<Invoice<'a>>,
    cause: Rc<Cause<'a>>,
    failed: Cell<bool>,
}
fn view(e: &Cause<'_>) -> Result<PlainData, demlik_tea::command::CommandContractError> {
    Ok(PlainData::Object(
        [("_tag".into(), PlainData::String(e.tag().into()))]
            .into_iter()
            .collect(),
    ))
}
fn run<'a>(text: &'a str) {
    let calls = Rc::new(Cell::new(0));
    let marker = Rc::new(Cell::new(7));
    let args = Rc::new(Parsed(text));
    let host = Host {
        args: Rc::clone(&args),
        result: Rc::new(Invoice(text, Rc::clone(&marker))),
        cause: Rc::new(Cause(text, Rc::clone(&marker))),
        failed: Cell::new(false),
    };
    let input = Rc::new(Input {
        calls: Rc::clone(&calls),
        marker: PhantomData,
    });
    let output = Rc::new(Output(PhantomData));
    let read = tool(
        "read_invoice",
        ToolSpec::new(
            Rc::clone(&input),
            Rc::clone(&output),
            ErrorFamily::new(["unavailable"], view),
        ),
        |args: &Rc<Parsed<'a>>, ctx: ToolContext<'_, Host<'a>>| {
            Box::pin(async move {
                assert!(Rc::ptr_eq(args, &ctx.host.args));
                assert_eq!(args.0, ctx.host.result.0);
                Ok(if ctx.host.failed.get() {
                    Outcome::err(Rc::clone(&ctx.host.cause))
                } else {
                    Outcome::ok(Rc::clone(&ctx.host.result))
                })
            })
        },
    )
    .unwrap();
    let check = tool(
        "check_invoice",
        ToolSpec::new(
            Rc::clone(&input),
            Rc::clone(&output),
            ErrorFamily::new(["unavailable"], view),
        ),
        |_: &Rc<Parsed<'a>>, ctx: ToolContext<'_, Host<'a>>| {
            Box::pin(async move { Ok(Outcome::ok(Rc::clone(&ctx.host.result))) })
        },
    )
    .unwrap();
    let router = invoices::Router::new(Rc::clone(&read), check).unwrap();
    assert!(Rc::ptr_eq(router.read().input_schema(), &input));
    assert!(Rc::ptr_eq(router.read().output_schema(), &output));
    for failed in [false, true] {
        host.failed.set(failed);
        let command = invoices::Commands::Read(read.from_input(ToolInput {
            call_id: "retained-call".into(),
            args: Rc::clone(&args),
        }));
        let completion =
            futures::executor::block_on(router.interpret(&command, ToolContext::bare(&host)))
                .unwrap();
        let settled = command
            .settle_in(completion, &CommandEdge::new(|| 17.25))
            .unwrap();
        let invoices::Messages::Read(message) = &settled[0] else {
            panic!("wrong tool")
        };
        assert_eq!(
            message.cmd().input().call_id.as_utf8(),
            Some("retained-call")
        );
        assert!(Rc::ptr_eq(&message.cmd().input().args, &args));
        match message.outcome() {
            Settlement::Ok(value) => {
                assert!(!failed);
                assert!(Rc::ptr_eq(value, &host.result));
                assert!(Rc::ptr_eq(&value.1, &marker));
            }
            Settlement::Err(Failure::Declared(ToolFailure::Declared(error))) => {
                assert!(failed);
                assert!(Rc::ptr_eq(error, &host.cause));
                assert_eq!(error.0, text);
                assert!(Rc::ptr_eq(&error.1, &marker));
            }
            _ => panic!("opaque failure replaced"),
        }
    }
    assert_eq!(calls.get(), 0);
}
fn main() {
    let text = String::from("borrowed invoice");
    run(&text);
}
