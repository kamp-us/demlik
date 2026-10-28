use demlik_tea::agent::{
    tool::{ErrorFamily, Raised, ToolContext, ToolSpec, tool},
    types::{ToolCall, ToolOutcome},
};
use demlik_tea::tool_router;
use demlik_tea::{
    PlainData, Tagged,
    command::{Outcome, SchemaError},
    llm_call::Schema,
    resilience::resilient_call::CallValue,
};
use std::{cell::Cell, marker::PhantomData, rc::Rc};

tool_router! { pub mod invoice_tools { Read(read), Check(check) } }
struct Raw<'a> {
    invoice: &'a str,
    value: i32,
}
struct ReadArgs<'a>(&'a str);
struct CheckArgs(i32);
struct ReadOk<'a>(&'a str, Rc<Cell<u32>>);
struct CheckOk(bool);
struct Cause<'a>(&'a str, Rc<Cell<u32>>);
struct Unavailable<'a>(Rc<Cause<'a>>);
impl Tagged for Unavailable<'_> {
    fn tag(&self) -> &str {
        "unavailable"
    }
}
struct InputRead<'a>(PhantomData<&'a ()>);
impl<'a> Schema for InputRead<'a> {
    type Raw = Rc<Raw<'a>>;
    type Output = Rc<ReadArgs<'a>>;
    type Error = SchemaError;
    fn parse(&self, v: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        Ok(Rc::new(ReadArgs(v.invoice)))
    }
}
struct InputCheck<'a>(PhantomData<&'a ()>);
impl<'a> Schema for InputCheck<'a> {
    type Raw = Rc<Raw<'a>>;
    type Output = Rc<CheckArgs>;
    type Error = SchemaError;
    fn parse(&self, v: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        Ok(Rc::new(CheckArgs(v.value)))
    }
}
struct OutputRead<'a>(PhantomData<&'a ()>);
impl<'a> Schema for OutputRead<'a> {
    type Raw = Rc<ReadOk<'a>>;
    type Output = Rc<ReadOk<'a>>;
    type Error = SchemaError;
    fn parse(&self, v: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        Ok(v)
    }
}
struct OutputCheck;
impl Schema for OutputCheck {
    type Raw = Rc<CheckOk>;
    type Output = Rc<CheckOk>;
    type Error = SchemaError;
    fn parse(&self, v: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        Ok(v)
    }
}
struct Host<'a> {
    label: &'a str,
    result: Rc<ReadOk<'a>>,
    cause: Rc<Cause<'a>>,
}
fn view<E: Tagged>(e: &E) -> Result<PlainData, demlik_tea::command::CommandContractError> {
    Ok(PlainData::Object(
        [("_tag".into(), PlainData::String(e.tag().into()))]
            .into_iter()
            .collect(),
    ))
}
fn run<'a>(text: &'a str) {
    let marker = Rc::new(Cell::new(7));
    let host = Host {
        label: text,
        result: Rc::new(ReadOk(text, Rc::clone(&marker))),
        cause: Rc::new(Cause(text, Rc::clone(&marker))),
    };
    let input = Rc::new(InputRead(PhantomData));
    let output = Rc::new(OutputRead(PhantomData));
    let parts = Rc::new(std::cell::RefCell::new(vec![
        demlik_tea::agent::content::ContentPart::Text(Rc::new(
            demlik_tea::agent::content::TextPart { text: text.into() },
        )),
    ]));
    let retained_parts = Rc::clone(&parts);
    let content_cause = Rc::clone(&host.cause);
    let read = tool(
        "read_invoice",
        ToolSpec::new(
            Rc::clone(&input),
            Rc::clone(&output),
            ErrorFamily::<Unavailable<'a>>::new(["unavailable"], view),
        )
        .description("Read an invoice")
        .try_content(move |_| {
            if content_cause.1.get() == 8 {
                Err(Rc::clone(&content_cause))
            } else {
                Ok(Rc::clone(&retained_parts))
            }
        }),
        |args: &Rc<ReadArgs<'a>>, ctx: ToolContext<'_, Host<'a>>| {
            Box::pin(async move {
                assert_eq!(args.0, ctx.host.label);
                Ok(Outcome::ok(Rc::clone(&ctx.host.result)))
            })
        },
    )
    .unwrap();
    let check = tool(
        "check_invoice",
        ToolSpec::new(
            Rc::new(InputCheck(PhantomData)),
            Rc::new(OutputCheck),
            ErrorFamily::<Unavailable<'a>>::new(["unavailable"], view),
        )
        .description("Check invoice lines"),
        |args: &Rc<CheckArgs>, ctx: ToolContext<'_, Host<'a>>| {
            Box::pin(async move {
                if args.0 < 0 {
                    Err(Raised::Declared(Rc::new(Unavailable(Rc::clone(
                        &ctx.host.cause,
                    )))))
                } else {
                    Ok(Outcome::ok(Rc::new(CheckOk(args.0 == 15))))
                }
            })
        },
    )
    .unwrap();
    let tools = invoice_tools::Router::new(read, check).unwrap();
    assert!(Rc::ptr_eq(tools.read().input_schema(), &input));
    assert!(Rc::ptr_eq(tools.read().output_schema(), &output));
    let call = ToolCall {
        call_id: "invoice-1".into(),
        name: "read_invoice".into(),
        args: Rc::new(Raw {
            invoice: text,
            value: 15,
        }),
    };
    let command = tools.tool_of(&call).unwrap();
    let completion =
        futures::executor::block_on(tools.interpret(&command, ToolContext::bare(&host))).unwrap();
    let messages = demlik_tea::command::CommandFamily::settle_in(
        command,
        completion,
        &demlik_tea::command::CommandEdge::new(|| 17.25),
    )
    .unwrap();
    let settled = tools.outcome_of(&messages[0]).unwrap().unwrap();
    let ToolOutcome::Ok(ref result) = settled.outcome else {
        panic!("read failed")
    };
    let invoice_tools::Results::Read(original) = result.as_ref() else {
        panic!("wrong result family")
    };
    assert!(Rc::ptr_eq(original, &host.result));
    assert_eq!(original.0, text);
    assert!(Rc::ptr_eq(&original.1, &marker));
    let rendered = tools
        .parts_of(&call, &settled.outcome)
        .unwrap_or_else(|_| panic!("content failure"))
        .unwrap();
    assert!(Rc::ptr_eq(&rendered, &parts));
    assert!(rendered.borrow()[0].same_identity(&parts.borrow()[0]));
    let checked_call = ToolCall {
        call_id: "checked".into(),
        name: "check_invoice".into(),
        args: Rc::new(Raw {
            invoice: text,
            value: 15,
        }),
    };
    let checked = tools.tool_of(&checked_call).unwrap();
    let completed =
        futures::executor::block_on(tools.interpret(&checked, ToolContext::bare(&host))).unwrap();
    let checked = demlik_tea::command::CommandFamily::settle_in(
        checked,
        completed,
        &demlik_tea::command::CommandEdge::new(|| 17.25),
    )
    .unwrap();
    let checked = tools.outcome_of(&checked[0]).unwrap().unwrap();
    let ToolOutcome::Ok(value) = checked.outcome else {
        panic!("check failed")
    };
    let invoice_tools::Results::Check(value) = value.as_ref() else {
        panic!("wrong check result")
    };
    assert!(value.0);
    let failure_call = ToolCall {
        call_id: "failure".into(),
        name: "check_invoice".into(),
        args: Rc::new(Raw {
            invoice: text,
            value: -1,
        }),
    };
    let failure_command = tools.tool_of(&failure_call).unwrap();
    let completion =
        futures::executor::block_on(tools.interpret(&failure_command, ToolContext::bare(&host)))
            .unwrap();
    let failed = demlik_tea::command::CommandFamily::settle_in(
        failure_command,
        completion,
        &demlik_tea::command::CommandEdge::new(|| 17.25),
    )
    .unwrap();
    let failure = tools.outcome_of(&failed[0]).unwrap().unwrap();
    let ToolOutcome::Error(error) = failure.outcome else {
        panic!("missing failure")
    };
    let invoice_tools::Errors::Check(view) = error.as_ref() else {
        panic!("wrong failure family")
    };
    let demlik_tea::command::Failure::Declared(demlik_tea::agent::tool::ToolFailure::Declared(
        original_error,
    )) = &view.error
    else {
        panic!("failure remapped")
    };
    assert!(Rc::ptr_eq(&original_error.0, &host.cause));
    assert!(
        tools
            .parts_of(&failure_call, &ToolOutcome::Error(Rc::clone(&error)))
            .unwrap_or_else(|_| panic!("content called on failure"))
            .is_none()
    );
    marker.set(8);
    let content_failure = tools.parts_of(&call, &settled.outcome).err().unwrap();
    let invoice_tools::ContentErrors::Read(original_content) = content_failure;
    assert!(Rc::ptr_eq(&original_content, &host.cause));
    marker.set(7);
    drop(tools);
    assert!(Rc::ptr_eq(&original_error.0, &host.cause));
    assert!(Rc::ptr_eq(original, &host.result));
    assert_eq!(host.cause.0, text);
    assert!(Rc::ptr_eq(&host.cause.1, &marker));
    println!(
        "inferred-two-tools: borrowed raw/args/result/host/cause; canonical schema/result owners"
    );
}
fn main() {
    let text = String::from("inv-17");
    run(&text);
}
