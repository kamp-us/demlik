#[path = "../examples/agent_turn/scenario.rs"]
mod scenario;
use demlik_tea::{
    PlainData, Tagged,
    agent::{
        AgentCommand, AgentConfig, create_agent,
        types::{AgentTurn, Conversation, ToolCall, ToolOutcome},
    },
    llm_call::{self, LlmCall, Schema},
    resilience::resilient_call::CallValue,
};
use std::{cell::Cell, marker::PhantomData, rc::Rc};
struct Opaque<'a>(&'a Cell<u32>);
struct Tool<'a>(Rc<ToolCall<Opaque<'a>>>);
impl Tagged for Tool<'_> {
    fn tag(&self) -> &str {
        "invoice_tool"
    }
}
struct Parser<'a>(PhantomData<&'a Cell<u32>>);
impl<'a> Schema for Parser<'a> {
    type Raw = Rc<AgentTurn<Opaque<'a>, Opaque<'a>>>;
    type Output = Self::Raw;
    type Error = Opaque<'a>;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<Self::Error>> {
        Ok(raw)
    }
}
#[test]
fn native_call_owner_survives_opaque_invoice_tool_and_record_workflow() {
    let token = Cell::new(15);
    let args = Rc::new(Opaque(&token));
    let call = Rc::new(ToolCall {
        call_id: "read-invoice".into(),
        name: "collect".into(),
        args: Rc::clone(&args),
    });
    let expected = Rc::clone(&call);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(|_: &&str| Rc::new(Parser(PhantomData))),
        |_: &Opaque<'_>| Ok("rejected".into()),
    ));
    let agent = create_agent(AgentConfig::new(
        llm,
        vec![Rc::new(())],
        |_| "invoice",
        move |actual| {
            assert!(
                Rc::ptr_eq(actual, &expected),
                "native invoice call keeps original owner"
            );
            Tool(Rc::clone(actual))
        },
        |_,
         _: &Rc<
            Conversation<Opaque<'_>, AgentTurn<Opaque<'_>, Opaque<'_>>, PlainData, Opaque<'_>>,
        >,
         _| (),
        |turn| turn,
    ));
    let started = agent.start(&agent.init(), "invoice", 0.0).unwrap().state;
    let turn = Rc::new(AgentTurn::new("collect".into(), vec![Rc::clone(&call)]));
    let launched = agent.turn(&started, Rc::clone(&turn), 1.0).unwrap();
    let AgentCommand::Tool(command) = &launched.commands[0] else {
        panic!("tool command")
    };
    assert!(Rc::ptr_eq(&command.0, &call));
    assert!(Rc::ptr_eq(&launched.state.tools.running[0], &call));
    drop(turn);
    let result = Rc::new(Opaque(&token));
    let settled = agent
        .tool_ok(&launched.state, "read-invoice", Rc::clone(&result), 2.0)
        .unwrap();
    let conversation = settled.state.conversation.as_ref().unwrap();
    let record = &conversation.tool_records[0];
    assert!(Rc::ptr_eq(&record.call, &call));
    assert!(Rc::ptr_eq(&record.call.args, &args));
    let ToolOutcome::Ok(value) = record.outcome.as_ref() else {
        panic!("tool result")
    };
    assert!(Rc::ptr_eq(value, &result));
    token.set(18);
    assert_eq!(record.call.args.0.get(), 18);
    let finished = agent
        .turn(
            &settled.state,
            Rc::new(AgentTurn::new("checked".into(), vec![])),
            3.0,
        )
        .unwrap();
    assert!(finished.state.is_settled());
}
#[tokio::test(flavor = "current_thread")]
async fn guarded_invoice_workflow_preserves_views_and_clears_unreported_context() {
    tokio::task::LocalSet::new().run_until(async {
        for profile in ["promise","effect"] {
            for mode in ["extras","array-args","presence","usage-missing","usage-undefined","usage-totals"] {
                let out=scenario::execute(serde_json::from_value(serde_json::json!({"profile":profile,"scenario":"restart-tool","turnMode":mode})).unwrap()).await;
                let view=&out["view"];
                assert_eq!(view["state"]["output"],"Invoice total confirmed: 15");
                assert_eq!(view["restart"]["loadedSame"],true);
                assert_eq!(view["restart"]["newModelCallsAtReady"],0);
                for flag in view["ownership"].as_object().unwrap().values(){assert_eq!(flag,true);}
                assert!(view["codecs"].as_array().unwrap().iter().all(|c|c["recordRoundTrip"]==true&&c["conversationRoundTrip"]==true));
                if mode.starts_with("usage-") {
                    assert_eq!(view["state"]["usage"],serde_json::json!({"inputTokens":15,"outputTokens":5,"reasoningTokens":3,"cachedInputTokens":4}));
                }
                if ["usage-missing","usage-undefined"].contains(&mode) {
                    assert!(view["usageReadings"].as_array().unwrap().iter().any(|r|r[1]=="collect"&&r[2]=="tools"&&r[4].is_null()));
                }
            }
        }
    }).await;
}
