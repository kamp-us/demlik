//! Public inferred borrowed policy consumer; Runtime ownership is a separate profile.
use demlik_tea::{
    PlainData, Tagged,
    agent::{
        AgentConfig, create_agent,
        types::{AgentTurn, Conversation, ToolCall},
    },
    llm_call::{self, LlmCall, Schema},
    resilience::resilient_call::CallValue,
};
use std::{cell::Cell, rc::Rc};

struct Args<'a>(&'a str, Rc<Cell<u32>>);
struct Payload<'a>(&'a str);
struct ResultValue<'a>(&'a str, Rc<Cell<u32>>);
struct Cause<'a>(&'a str, Rc<Cell<u32>>);
type Turn<'a> = AgentTurn<Args<'a>, ()>;
struct Parser<'a>(Rc<Cause<'a>>);
impl<'a> Schema for Parser<'a> {
    type Raw = Rc<Turn<'a>>;
    type Output = Rc<Turn<'a>>;
    type Error = Cause<'a>;
    fn parse(&self, _: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        Err(CallValue::shared(Rc::clone(&self.0)))
    }
}
struct Tool<'a>(Rc<ToolCall<Args<'a>>>);
impl Tagged for Tool<'_> {
    fn tag(&self) -> &str {
        "invoice_tool"
    }
}
fn main() {
    let text = String::from("borrowed invoice");
    let borrowed = text.as_str();
    let marker = Rc::new(Cell::new(7));
    let cause = Rc::new(Cause(borrowed, Rc::clone(&marker)));
    let schema = Rc::new(Parser(Rc::clone(&cause)));
    let schemas = Rc::clone(&schema);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(move |_: &&str| Rc::clone(&schemas)),
        |cause: &Cause<'_>| Ok(cause.0.into()),
    ));
    let args = Rc::new(Args(borrowed, Rc::clone(&marker)));
    let call = Rc::new(ToolCall {
        call_id: "invoice-1".into(),
        name: "lookup".into(),
        args,
    });
    let tool = Tool(Rc::clone(&call));
    assert!(Rc::ptr_eq(&tool.0, &call));
    assert_eq!(call.args.0, borrowed);
    assert!(Rc::ptr_eq(&call.args.1, &marker));
    let result = Rc::new(ResultValue(borrowed, Rc::clone(&marker)));
    assert_eq!(result.0, borrowed);
    assert!(Rc::ptr_eq(&result.1, &marker));
    let raw = Rc::new(Turn::new("original turn".into(), vec![Rc::clone(&call)]));
    let Err(CallValue::Shared(actual)) = schema.parse(raw) else {
        panic!("original opaque cause")
    };
    assert!(Rc::ptr_eq(&actual, &cause));
    assert!(Rc::ptr_eq(&actual.1, &marker));
    let selections = Cell::new(0);
    let config = AgentConfig::new(
        llm,
        vec![Rc::new(borrowed)],
        |_| "invoice",
        |call| Tool(Rc::clone(call)),
        |_, _: &Rc<Conversation<ResultValue<'_>, Turn<'_>, PlainData, Args<'_>>>, _| {
            Payload(borrowed)
        },
        |turn| turn,
    )
    .tool_resilience_of(|call| {
        selections.set(selections.get() + 1);
        assert!(Rc::ptr_eq(call, &tool.0));
        None
    });
    let agent = create_agent(config);
    let state = agent.init();
    assert_eq!(
        selections.get(),
        0,
        "construction and init never select a policy"
    );
    assert!(
        agent.start(&state, "r", 0.0).is_ok(),
        "bare selector must preserve ordinary start"
    );
    assert_eq!(
        selections.get(),
        0,
        "start must not select a policy before a tool launch"
    );
    let payload = Payload(borrowed);
    assert_eq!(payload.0, borrowed);
    println!(
        "tool-policy-interface: inferred borrowed arguments/result/cause; original Rc; deferred callback; ordinary start remains supported"
    );
}
