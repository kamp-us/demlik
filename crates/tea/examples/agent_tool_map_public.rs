//! Inferred borrowed mapping errors are separate from persisted business errors.
use demlik_tea::{
    Tagged,
    agent::{
        AgentConfig, AgentError, create_agent,
        tool::ToolError,
        types::{AgentField, AgentTurn, Conversation, ToolCall},
    },
    flow::fan_out::{FanOut, FanOutConfig, FanOutState},
    llm_call::{self, LlmCall, Schema},
    resilience::resilient_call::CallValue,
};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    marker::PhantomData,
    rc::Rc,
};
struct Input<'a> {
    id: &'a str,
    marker: &'a Cell<usize>,
}
struct ResultValue<'a>(&'a str);
struct Business<'a>(&'a Cell<usize>);
struct Mapping<'a>(&'a str, &'a Cell<usize>);
struct Command<'a>(Rc<Input<'a>>);
impl Tagged for Command<'_> {
    fn tag(&self) -> &str {
        "invoice"
    }
}
struct Parser<A>(PhantomData<A>);
impl<A> Schema for Parser<A> {
    type Raw = Rc<AgentTurn<A>>;
    type Output = Rc<AgentTurn<A>>;
    type Error = Infallible;
    fn parse(&self, v: Self::Raw) -> Result<Self::Output, CallValue<Infallible>> {
        Ok(v)
    }
}
fn fan<'a>(label: &'a str, marker: &'a Cell<usize>) {
    let cause = Rc::new(Mapping(label, marker));
    let seen = RefCell::new(vec![]);
    let original = Rc::new(Input { id: label, marker });
    let second = Rc::new(Input { id: "next", marker });
    let fan = FanOut::new(FanOutConfig::try_new(
        3.,
        |i: &Input<'a>| i.id.into(),
        |i| {
            seen.borrow_mut().push(i.id);
            if i.id == "next" {
                Err(Rc::clone(&cause))
            } else {
                Ok(Command(Rc::clone(i)))
            }
        },
    ));
    let seed: Rc<FanOutState<Input<'a>, ResultValue<'a>, Business<'a>>> =
        Rc::new(FanOutState::default());
    let Err(error) = fan.try_scatter(&seed, [Rc::clone(&original), second]) else {
        panic!("mapper failure became a Step")
    };
    assert!(Rc::ptr_eq(&error, &cause));
    assert!(std::ptr::eq(error.1, marker));
    assert_eq!(error.0, label);
    assert_eq!(*seen.borrow(), [label, "next"]);
    assert!(seed.items.is_empty());
    assert!(std::ptr::eq(original.marker, marker));
    let launched = fan
        .try_scatter(&seed, [Rc::clone(&original)])
        .unwrap_or_else(|_| panic!("one permitted item failed"));
    let business = Rc::new(Business(marker));
    let settled = fan
        .try_item_err(&launched.state, &label.into(), Rc::clone(&business))
        .unwrap_or_else(|_| panic!("business failure became mapping rejection"));
    assert!(Rc::ptr_eq(&settled.state.failed[0].error, &business));
    assert!(Rc::ptr_eq(&settled.state.failed[0].item, &original));
    let infallible = FanOut::new(FanOutConfig::new(
        1.,
        |i: &Input<'a>| i.id.into(),
        |i| Command(Rc::clone(i)),
    ));
    let step = infallible.scatter(&seed, [Rc::clone(&original)]);
    assert!(Rc::ptr_eq(&step.commands[0].0, &original));
}
fn agent<'a>(label: &'a str, marker: &'a Cell<usize>) {
    let schema = Rc::new(Parser::<Input<'a>>(PhantomData));
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(move |_: &&str| Rc::clone(&schema)),
        |_: &Infallible| Ok("unreachable".into()),
    ));
    let expected = Rc::new(ToolError::Reserved { name: label.into() });
    let counter = Cell::new(0);
    let inputs = RefCell::new(vec![]);
    let agent = create_agent(AgentConfig::try_new(
        llm,
        vec![Rc::new(Input { id: label, marker })],
        |_| "collect",
        |call| {
            inputs.borrow_mut().push(Rc::clone(call));
            counter.set(counter.get() + 1);
            Err::<Command<'a>, _>(Rc::clone(&expected))
        },
        |_,
         _: &Rc<Conversation<ResultValue<'a>, AgentTurn<Input<'a>>, Business<'a>, Input<'a>>>,
         _| (),
        |turn: &AgentTurn<Input<'a>>| turn,
    ));
    let seed = agent.init();
    let started = agent
        .start(&seed, "r", 10.)
        .unwrap_or_else(|_| panic!("start failed"));
    assert_eq!(counter.get(), 0);
    let call = Rc::new(ToolCall {
        call_id: "c1".into(),
        name: "invoice".into(),
        args: Rc::new(Input { id: label, marker }),
    });
    let turn = Rc::new(AgentTurn {
        content: "check".into(),
        tool_calls: vec![Rc::clone(&call)],
        provider: AgentField::Absent,
        usage: AgentField::Absent,
    });
    let Err(AgentError::ToolMapping(error)) = agent.turn(&started.state, turn, 11.) else {
        panic!("typed mapping cause was changed")
    };
    assert!(Rc::ptr_eq(&error, &expected));
    let retained = AgentError::ToolMapping(Rc::clone(&error));
    assert_eq!(retained.name(), expected.name());
    assert_eq!(retained.to_string(), expected.to_string());
    let source = std::error::Error::source(&retained)
        .and_then(|e| e.downcast_ref::<ToolError>())
        .unwrap();
    assert!(std::ptr::eq(source, expected.as_ref()));
    let ladder =
        demlik_tea::agent::tool_resilience::ToolResilienceError::ToolMapping(Rc::clone(&expected));
    assert_eq!(ladder.name(), expected.name());
    assert_eq!(ladder.to_string(), expected.to_string());
    let source = std::error::Error::source(&ladder)
        .and_then(|e| e.downcast_ref::<ToolError>())
        .unwrap();
    assert!(std::ptr::eq(source, expected.as_ref()));
    let AgentError::ToolMapping(converted) = AgentError::from(ladder) else {
        panic!("mapping became a business error")
    };
    assert!(Rc::ptr_eq(&converted, &expected));
    assert!(Rc::ptr_eq(&inputs.borrow()[0], &call));
    assert!(std::ptr::eq(inputs.borrow()[0].args.marker, marker));
    assert_eq!(counter.get(), 1);
    assert!(started.state.tools.items.is_empty());
    // Exercise opaque fields without adding Clone/Debug/serde/Send to their owners.
    let result = ResultValue(label);
    let business = Business(marker);
    assert_eq!(result.0, label);
    assert!(std::ptr::eq(business.0, marker));
}
fn main() {
    let label = String::from("borrowed invoice");
    let marker = Cell::new(7);
    fan(&label, &marker);
    agent(&label, &marker);
    println!(
        "inferred-fallible-map: original borrowed input/opaque launch cause; business error independent; old infallible API and canonical Agent Rc intact"
    );
}
