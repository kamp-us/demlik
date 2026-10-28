//! Public borrowed opaque projector and unchanged/checked event builder callers.
use demlik_tea::{
    Tagged,
    agent::{
        AgentCompletion, AgentConfig, AgentMachineError, AgentMachineMsg, AgentToolMsg,
        agent_events, create_agent,
        transcript::Transcript,
        types::{AgentEvent, AgentField, AgentTurn, Conversation, ToolCall, TurnUsage},
    },
    command::{CommandContractError, CommandEdge, CommandFamily, Outcome},
    llm_call::{self, LlmCall, LlmOk, Schema},
    resilience::resilient_call::CallValue,
    runtime::{EventProjection, Options, Profile},
};
use std::{convert::Infallible, marker::PhantomData, rc::Rc};

// Deliberately no Clone, Debug, serde or Send implementation.
struct Loan<'a> {
    text: &'a str,
    local: Rc<()>,
}
struct OpaqueTurn<'a> {
    native: AgentTurn<Loan<'a>, Loan<'a>>,
}
fn view<'s, 'a>(turn: &'s OpaqueTurn<'a>) -> &'s AgentTurn<Loan<'a>, Loan<'a>> {
    &turn.native
}
struct Parser<'a>(PhantomData<&'a str>);
impl<'a> Schema for Parser<'a> {
    type Raw = Rc<OpaqueTurn<'a>>;
    type Output = Rc<OpaqueTurn<'a>>;
    type Error = Loan<'a>;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        Ok(raw)
    }
}
struct Tool<'a>(Rc<ToolCall<Loan<'a>>>);
impl Tagged for Tool<'_> {
    fn tag(&self) -> &str {
        "invoice_io"
    }
}
impl<'a> CommandFamily for Tool<'a> {
    type Msg = AgentToolMsg<Loan<'a>>;
    type Completion = Vec<Self::Msg>;
    fn settle(
        self,
        messages: Self::Completion,
        _: f64,
    ) -> Result<Vec<Self::Msg>, CommandContractError> {
        let _original_call = self.0;
        Ok(messages)
    }
}
type Msg<'a> =
    AgentMachineMsg<&'a str, Rc<Loan<'a>>, Rc<OpaqueTurn<'a>>, Loan<'a>, AgentToolMsg<Loan<'a>>>;

fn borrowed(text: &str) {
    let payload = Rc::new(Loan {
        text,
        local: Rc::new(()),
    });
    let original_payload = Rc::clone(&payload);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(|_: &&str| Rc::new(Parser(PhantomData))),
        |_: &Loan<'_>| Ok("rejected".into()),
    ));
    let agent = create_agent(AgentConfig::new(
        llm,
        vec![Rc::new(text)],
        |_| "invoice",
        |call| Tool(Rc::clone(call)),
        move |_, _: &Rc<Conversation<Loan<'_>, OpaqueTurn<'_>, Loan<'_>, Loan<'_>>>, _| {
            Rc::clone(&payload)
        },
        view,
    ));
    let projector = agent_events(view);
    let mut started = agent.start(&agent.init(), "invoice", 11.0).unwrap();
    let start: Msg<'_> = AgentMachineMsg::Start {
        run_id: "invoice".into(),
        at: 11.0,
    };
    let events = projector.project(&start, &started.state).unwrap();
    let AgentEvent::BrainStarted { payload, .. } = &events[0] else {
        panic!("brain event")
    };
    assert!(Rc::ptr_eq(payload, &original_payload));
    assert_eq!(payload.text, text);
    assert!(Rc::ptr_eq(&payload.local, &original_payload.local));
    assert!(
        projector
            .project(&start, &started.state)
            .unwrap()
            .is_empty()
    );

    let usage = Rc::new(TurnUsage {
        input_tokens: 17.0.into(),
        output_tokens: 5.0.into(),
        reasoning_tokens: AgentField::Value(2.0.into()),
        cached_input_tokens: AgentField::Value(3.0.into()),
    });
    let mut native = AgentTurn::new("invoice checked".into(), vec![]);
    native.usage = AgentField::Value(Rc::clone(&usage));
    let turn = Rc::new(OpaqueTurn { native });
    let edge = CommandEdge::new(|| 17.0);
    let message = started
        .commands
        .pop()
        .unwrap()
        .settle_in(
            AgentCompletion::Brain(Some(Outcome::ok(CallValue::value(LlmOk {
                key: "invoice".into(),
                purpose: "invoice",
                output: Rc::clone(&turn),
            })))),
            &edge,
        )
        .unwrap()
        .pop()
        .unwrap();
    let AgentMachineMsg::Brain(settled) = &message else {
        panic!("brain receipt")
    };
    let next = agent.succeed(&started.state, settled, 17.0).unwrap();
    let events = projector.project(&message, &next.state).unwrap();
    let collector = Transcript::new();
    for event in &events {
        collector.on_event(event);
    }
    let AgentEvent::TurnSettled {
        turn: actual,
        usage: AgentField::Value(actual_usage),
        ..
    } = &events[0]
    else {
        panic!("usage event")
    };
    assert!(Rc::ptr_eq(actual, &turn));
    assert!(Rc::ptr_eq(actual_usage, &usage));
    assert!(Rc::ptr_eq(&collector.read().turns[0], &turn));
    let _: Result<_, AgentMachineError> = projector
        .project(&message, &next.state)
        .map_err(AgentMachineError::from);
}

struct Ping;
impl Tagged for Ping {
    fn tag(&self) -> &str {
        "ping"
    }
}
struct Pulse;
impl Tagged for Pulse {
    fn tag(&self) -> &str {
        "pulse"
    }
}
fn checked_and_legacy_builders() {
    let cause = Rc::new(Loan {
        text: "projection refused",
        local: Rc::new(()),
    });
    let original = Rc::clone(&cause);
    let options =
        Options::<Loan<'static>, Ping, Infallible, Infallible, _, Rc<Loan<'static>>>::new(
            Profile::Promise,
        )
        .with_checked_events(move |_, _| Err::<Vec<Pulse>, _>(Rc::clone(&cause)));
    let selected = options.events.clone();
    let selected = selected.as_ref().unwrap().clone();
    let EventProjection::Checked(project) = selected else {
        panic!("checked owner")
    };
    let state = Loan {
        text: "nonClone state",
        local: Rc::new(()),
    };
    let Err(actual) = project(&Ping, &state) else {
        panic!("retained cause")
    };
    assert!(Rc::ptr_eq(&actual, &original));
    let options =
        Options::<Loan<'static>, Ping>::new(Profile::Promise).with_events(|_, _| vec![Pulse]);
    let selected = options.events.clone();
    let selected = selected.as_ref().unwrap().clone();
    let EventProjection::Plain(project) = selected else {
        panic!("legacy owner")
    };
    assert_eq!(project(&Ping, &state).len(), 1);
}
fn main() {
    let borrowed_owner = String::from("borrowed invoice");
    borrowed(&borrowed_owner);
    checked_and_legacy_builders();
    println!("borrowed opaque owners, original usage, legacy and checked builders");
}
