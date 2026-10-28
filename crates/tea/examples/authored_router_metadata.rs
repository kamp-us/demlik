use demlik_tea::{
    PlainData, Step, Tagged, TryUpdate,
    agent::{
        tool::{self, ErrorFamily, Raised, ToolContext, ToolSpec},
        types::ToolCall,
    },
    command::{CommandEdge, CommandFamily, Failure, Outcome, SchemaError, Settlement},
    core::ApplyError,
    llm_call::Schema,
    resilience::resilient_call::CallValue,
};
use std::{borrow::Cow, cell::Cell, marker::PhantomData, rc::Rc};

#[path = "../../../verification/parity/authored-state-interface-types/canonical.rs"]
mod canonical;

demlik_tea::tool_router! { pub mod invoice_tools { Check(check) } }
struct Invoice<'a> {
    label: &'a str,
    accepted: bool,
}
struct Receipt<'a>(&'a str);
struct RichCause<'a> {
    label: &'a str,
    visits: &'a Cell<usize>,
}
struct Rejected<'a>(Rc<RichCause<'a>>);
impl Tagged for Rejected<'_> {
    fn tag(&self) -> &str {
        "invoice_rejected"
    }
}
struct Identity<T>(PhantomData<T>);
impl<T> Schema for Identity<T> {
    type Raw = Rc<T>;
    type Output = Rc<T>;
    type Error = SchemaError;
    fn parse(&self, raw: Rc<T>) -> Result<Rc<T>, CallValue<SchemaError>> {
        Ok(raw)
    }
}
struct Host<'a> {
    receipt: Rc<Receipt<'a>>,
    cause: Rc<RichCause<'a>>,
}

fn run<'a>(label: &'a str, visits: &'a Cell<usize>) {
    let original_state = canonical::canonical(Cow::Borrowed(label));
    let host = Host {
        receipt: Rc::new(Receipt(label)),
        cause: Rc::new(RichCause { label, visits }),
    };
    let tool_name = format!("{label}_check");
    let check = tool::tool(
        tool_name.as_str(),
        ToolSpec::new(
            Rc::new(Identity::<Invoice<'a>>(PhantomData)),
            Rc::new(Identity::<Receipt<'a>>(PhantomData)),
            ErrorFamily::new(["invoice_rejected"], |error: &Rejected<'a>| {
                assert_eq!(error.0.label, label);
                Ok(PlainData::Object(
                    [("_tag".into(), PlainData::String(error.tag().into()))]
                        .into_iter()
                        .collect(),
                ))
            }),
        ),
        |args: &Rc<Invoice<'a>>, ctx: ToolContext<'_, Host<'a>>| {
            Box::pin(async move {
                assert_eq!(args.label, ctx.host.cause.label);
                if args.accepted {
                    Ok(Outcome::ok(Rc::clone(&ctx.host.receipt)))
                } else {
                    Err(Raised::Declared(Rc::new(Rejected(Rc::clone(
                        &ctx.host.cause,
                    )))))
                }
            })
        },
    )
    .unwrap();
    let tools = invoice_tools::Router::new(check).unwrap();
    let names = tools.settlement_types();
    assert_eq!(
        names,
        [
            format!("{label}_check_ok"),
            format!("{label}_check_err"),
            "tool_rejected_ok".into(),
            "tool_rejected_err".into()
        ]
    );
    let apply_count = Cell::new(0);
    let original_cause = Rc::clone(&host.cause);
    let original_receipt = Rc::clone(&host.receipt);
    let update =
        TryUpdate::try_reducer_with_types(names, |state: &Rc<canonical::State<'_>>, message| {
            let routed = tools.outcome_of(message).unwrap().unwrap();
            apply_count.set(apply_count.get() + 1);
            let invoice_tools::Messages::Check(message) = message else {
                panic!("unexpected rejection family")
            };
            assert_eq!(routed.call_id, message.cmd().input().call_id);
            assert_eq!(message.at().and_then(|at| at.number()), Some(17.25));
            assert!(message.engine_stamp().is_some());
            match message.outcome() {
                Settlement::Ok(value) => {
                    assert!(Rc::ptr_eq(value, &original_receipt));
                    assert_eq!(value.0, label);
                    Ok(Step::new(Rc::clone(state), vec![visits]))
                }
                Settlement::Err(Failure::Declared(tool::ToolFailure::Declared(error))) => {
                    assert!(Rc::ptr_eq(&error.0, &original_cause));
                    error.0.visits.set(error.0.visits.get() + 1);
                    Err(Rc::clone(&error.0))
                }
                _ => panic!("typed failure owner changed"),
            }
        });
    assert!(update.accepted_types(None).is_empty());
    assert_eq!(
        update.accepted_types(Some(&original_state)),
        tools.settlement_types()
    );
    for accepted in [true, false] {
        let call = ToolCall {
            call_id: if accepted { "checked" } else { "rejected" }.into(),
            name: tool_name.as_str().into(),
            args: Rc::new(Invoice { label, accepted }),
        };
        let command = tools.tool_of(&call).unwrap();
        let completion =
            futures::executor::block_on(tools.interpret(&command, ToolContext::bare(&host)))
                .unwrap();
        let messages = command
            .settle_in(completion, &CommandEdge::new(|| 17.25))
            .unwrap();
        assert_eq!(messages.len(), 1);
        match update.try_apply(&original_state, &messages[0]) {
            Ok(step) if accepted => {
                assert!(Rc::ptr_eq(&step.state, &original_state));
                assert_eq!(step.commands.len(), 1);
                assert!(std::ptr::eq(step.commands[0], visits));
            }
            Err(ApplyError::Reduce(error)) if !accepted => {
                assert!(Rc::ptr_eq(&error, &host.cause));
                assert_eq!(error.label, label);
                assert!(std::ptr::eq(error.visits, visits));
            }
            _ => panic!("mapping failure produced a successful step or lost its cause"),
        }
    }
    assert_eq!(apply_count.get(), 2);
    assert_eq!(visits.get(), 1);
    let empty = tool::EmptyRouter::new().unwrap();
    assert_eq!(
        empty.settlement_types(),
        ["tool_rejected_ok", "tool_rejected_err"]
    );
    println!(
        "authored-router-metadata: borrowed canonical Rc<StateOf>, ordered instance names, original timestamp/result/cause, typed failure without a Step"
    );
}
fn main() {
    let label = String::from("inv-17");
    let visits = Cell::new(0);
    run(&label, &visits);
}
