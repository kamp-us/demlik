use demlik_tea::{
    PlainData, Tagged,
    agent::{
        AgentCommand, AgentConfig, AgentMachineError, AgentMachineMsg, AgentToolMsg,
        AgentWorkError, create_agent,
        model::{Messages, NoMessages, plain_model},
        types::{AgentTurn, Conversation},
    },
    command::{CommandContractError, CommandFamily},
    core::ApplyError,
    data::{JsText, NumberOrNull},
    llm_call::{self, LlmCall, LlmMsg, LlmOk, Schema},
    resilience::resilient_call::CallValue,
    runtime::NoInterpreter,
    timing::TokioTimer,
};
use std::{convert::Infallible, rc::Rc};
type Turn = AgentTurn;
struct Parser;
impl Schema for Parser {
    type Raw = Rc<Turn>;
    type Output = Rc<Turn>;
    type Error = PlainData;
    fn parse(&self, v: Self::Raw) -> Result<Self::Output, CallValue<PlainData>> {
        Ok(v)
    }
}
struct Tool;
impl Tagged for Tool {
    fn tag(&self) -> &str {
        "unused_tool"
    }
}
impl CommandFamily for Tool {
    type Msg = AgentToolMsg<PlainData>;
    type Completion = Vec<Self::Msg>;
    fn settle(self, v: Self::Completion, _: f64) -> Result<Vec<Self::Msg>, CommandContractError> {
        Ok(v)
    }
}
#[test]
fn missing_and_restored_null_brain_stamps_refuse_explicitly_as_an_open_profile() {
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(|_: &JsText| Rc::new(Parser)),
        |_: &PlainData| Ok("rejected".into()),
    ));
    let agent = Rc::new(create_agent(AgentConfig::new(
        llm,
        vec![Rc::new(())],
        |_| JsText::from("collect"),
        |_| Tool,
        |_, _: &Rc<Conversation<PlainData, Turn, PlainData, PlainData>>, _| PlainData::Null,
        |v| v,
    )));
    let model = plain_model(
        async |_: Messages<'_, ()>| -> Result<Rc<Turn>, CallValue<PlainData>> {
            Ok(Rc::new(Turn::new("unused".into(), vec![])))
        },
    );
    let wired = Rc::clone(&agent).to_machine(
        model,
        NoMessages,
        NoInterpreter::<AgentWorkError<Infallible>>::new(),
        Rc::new(TokioTimer::new(|_| {})),
    );
    for (case, at) in [
        ("missing", None),
        ("restored-null", Some(f64::NAN)),
        ("finite", Some(17.25)),
        ("numeric-nan", Some(f64::NAN)),
    ] {
        let mut step = agent.start(&agent.init(), "r", 0.0).unwrap();
        let AgentCommand::Brain(cmd) = step.commands.pop().unwrap() else {
            unreachable!()
        };
        let msg = agent.brain().ok(
            cmd,
            CallValue::value(LlmOk {
                key: "collect".into(),
                purpose: "collect".into(),
                output: Rc::new(Turn::new("done".into(), vec![])),
            }),
            at,
        );
        let msg = if case == "restored-null" {
            let text = serde_json::to_vec(&msg).unwrap();
            let parsed: LlmMsg<JsText, PlainData, Rc<Turn>, PlainData> =
                serde_json::from_slice(&text).unwrap();
            assert_eq!(parsed.at(), Some(NumberOrNull(None)));
            parsed
        } else {
            msg
        };
        let result = wired
            .machine
            .update
            .try_apply(&step.state, &AgentMachineMsg::Brain(msg));
        match case {
            "missing" => assert!(matches!(
                result,
                Err(ApplyError::Reduce(AgentMachineError::UnsupportedStamp {
                    at: None
                }))
            )),
            "restored-null" => assert!(matches!(
                result,
                Err(ApplyError::Reduce(AgentMachineError::UnsupportedStamp {
                    at: Some(NumberOrNull(None))
                }))
            )),
            _ => assert!(result.is_ok()),
        }
    }
}
