//! Actual guarded plain turn, retained call views, tool IO and explicit restart.
use demlik_tea::{
    PlainData, Tagged,
    agent::{
        AgentConfig, AgentMachineMsg, AgentToolMsg, AgentWorkError, GuardedSchema, PlainCalls,
        PlainToolCall, StateOf, StructuredOutputError, agent_boot_msg, create_agent,
        model::{Messages, NoMessages, plain_model},
        types::{AGENT_TURN_SCHEMA, AgentField, Conversation, ToolOutcome, ToolRecordOf},
    },
    command::{CommandContractError, CommandFamily},
    data::{JsText, decode_json},
    llm_call::{self, LlmCall},
    runtime::{self, CommandContext, CommandWork, Interpreter, Options, Profile, RuntimeError},
    storage::{Migrated, Store},
    timing::TokioTimer,
};
use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    convert::Infallible,
    rc::Rc,
};

struct Prompt;
struct Pause(Cell<u32>);
enum HostFailure {
    Pause(Rc<Pause>),
    Io(std::io::Error),
}
struct Tool(Rc<PlainToolCall>);
impl Tagged for Tool {
    fn tag(&self) -> &str {
        "invoice_tool"
    }
}
impl CommandFamily for Tool {
    type Msg = AgentToolMsg<PlainData>;
    type Completion = Vec<Self::Msg>;
    fn settle(
        self,
        messages: Self::Completion,
        _: f64,
    ) -> Result<Vec<Self::Msg>, CommandContractError> {
        Ok(messages)
    }
}
type Msg =
    AgentMachineMsg<JsText, Prompt, Rc<PlainData>, StructuredOutputError, AgentToolMsg<PlainData>>;
type State = StateOf<
    (),
    JsText,
    Prompt,
    GuardedSchema,
    PlainData,
    PlainData,
    PlainData,
    PlainData,
    PlainCalls,
>;
struct Saved(Rc<RefCell<Option<Rc<State>>>>);
impl Store<Rc<State>> for Saved {
    type Raw = Option<Rc<State>>;
    type Error = Infallible;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        Ok(self.0.borrow().clone())
    }
    async fn save(&self, state: &Rc<State>) -> Result<(), Self::Error> {
        self.0.replace(Some(Rc::clone(state)));
        Ok(())
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<Rc<State>> {
        raw.map_or(Migrated::Fresh, Migrated::State)
    }
}
struct Tools {
    pause: Rc<Cell<bool>>,
    cause: Rc<Pause>,
    io: Rc<Cell<u32>>,
}
impl Interpreter<Tool, Msg> for Tools {
    type Error = AgentWorkError<HostFailure>;
    fn interpret<'a>(
        &'a self,
        cmd: &'a Tool,
        _: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<AgentToolMsg<PlainData>>, Self::Error>> {
        Some(CommandWork::new(async move {
            if self.pause.replace(false) {
                return Err(AgentWorkError::Tool(HostFailure::Pause(Rc::clone(
                    &self.cause,
                ))));
            }
            assert_eq!(cmd.0.name().as_utf8(), Some("collect"));
            let PlainData::Object(args) = cmd.0.args() else {
                panic!("invoice args are an object")
            };
            let PlainData::String(path) = &args["path"] else {
                panic!("invoice path is a string")
            };
            assert!(
                matches!(&args["unknownArg"],PlainData::String(v) if v.as_utf8()==Some("kept"))
            );
            let text = tokio::fs::read_to_string(path.as_utf8().unwrap())
                .await
                .map_err(|e| AgentWorkError::Tool(HostFailure::Io(e)))?;
            assert_eq!(text, "15\n");
            self.io.set(self.io.get() + 1);
            Ok(vec![AgentToolMsg::Ok {
                call_id: cmd.0.call_id().clone(),
                result: Rc::new(PlainData::Number(15.0)),
                at: 17.25,
            }])
        }))
    }
}
fn raw_call(turn: &PlainData) -> &PlainData {
    let PlainData::Object(turn) = turn else {
        panic!("turn")
    };
    let PlainData::Array(calls) = &turn["toolCalls"] else {
        panic!("calls")
    };
    &calls[0]
}
fn raw_args(call: &PlainData) -> &PlainData {
    let PlainData::Object(call) = call else {
        panic!("call")
    };
    &call["args"]
}
async fn consume(profile: Profile) {
    let directory = std::env::current_dir()
        .unwrap()
        .join("target/parity/agent-turn-interface-io")
        .join(format!("{}-{profile:?}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let invoice = directory.join("invoice.txt");
    std::fs::write(&invoice, "15\n").unwrap();
    let first=Rc::new(decode_json(&format!(r#"{{"content":"collect","toolCalls":[{{"callId":"read-1","name":"collect","args":{{"path":{},"unknownArg":"kept"}},"unknownCall":{{"kept":true}}}}],"usage":{{"inputTokens":7,"outputTokens":2}},"unknownTurn":[1,null],"provider":null}}"#,serde_json::to_string(&invoice).unwrap())).unwrap());
    let last = Rc::new(
        decode_json(r#"{"content":"invoice checked:15","toolCalls":[],"unknownFinal":"kept"}"#)
            .unwrap(),
    );
    let schema = Rc::new(AGENT_TURN_SCHEMA);
    let schema_handle = Rc::clone(&schema);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(move |_: &JsText| Rc::clone(&schema_handle)),
        StructuredOutputError::describe,
    ));
    let observed = Rc::new(RefCell::new(None::<Rc<PlainToolCall>>));
    let recorded = Rc::new(RefCell::new(
        None::<Rc<ToolRecordOf<PlainData, PlainData, PlainData, PlainCalls>>>,
    ));
    let seen = Rc::clone(&observed);
    let expected = Rc::downgrade(&first);
    let record = Rc::clone(&recorded);
    let agent = Rc::new(create_agent(AgentConfig::from_plain_turns(
        llm,
        vec![Rc::new(())],
        |_| JsText::from("invoice"),
        move |call| {
            let expected = expected.upgrade().expect("retained original turn");
            assert!(Rc::ptr_eq(call.owner(), &expected));
            assert!(std::ptr::eq(call.raw_call(), raw_call(&expected)));
            assert!(std::ptr::eq(call.args(), raw_args(raw_call(&expected))));
            if let Some(prior) = seen.borrow().as_ref() {
                assert!(Rc::ptr_eq(call, prior));
            }
            seen.replace(Some(Rc::clone(call)));
            Tool(Rc::clone(call))
        },
        move |_, history, _| {
            if let Some(value) = history.tool_records.first() {
                let ToolOutcome::Ok(result) = value.outcome.as_ref() else {
                    panic!("successful tool")
                };
                assert!(matches!(&**result, PlainData::Number(15.0)));
                record.replace(Some(Rc::clone(value)));
            }
            Prompt
        },
    )));
    let responses = Rc::new(RefCell::new(VecDeque::from([
        Rc::clone(&first),
        Rc::clone(&last),
    ])));
    let models = Rc::new(Cell::new(0));
    let pause = Rc::new(Cell::new(true));
    let cause = Rc::new(Pause(Cell::new(8)));
    let io = Rc::new(Cell::new(0));
    let errors = Rc::new(Cell::new(0));
    let first_owner = Rc::downgrade(&first);
    let mut external_first = Some(first);
    let saved = Rc::new(RefCell::new(None::<Rc<State>>));
    let mut loaded = None;
    for round in 0..2 {
        let replies = Rc::clone(&responses);
        let calls = Rc::clone(&models);
        let model = plain_model(async move |_: Messages<'_, ()>| {
            calls.set(calls.get() + 1);
            Ok(replies.borrow_mut().pop_front().unwrap())
        });
        let tools = Tools {
            pause: Rc::clone(&pause),
            cause: Rc::clone(&cause),
            io: Rc::clone(&io),
        };
        let wired = Rc::clone(&agent).to_machine(
            model,
            NoMessages,
            tools,
            Rc::new(TokioTimer::with_clock(|| 17.25, |_| {})),
        );
        let mut options = Options::new(profile);
        options.clock = Rc::new(|| 17.25);
        options.store = Some(runtime::Persistence::new(Saved(Rc::clone(&saved))));
        options.terminal = Some(Rc::new(|state: &Rc<State>| state.is_settled()));
        let same = Rc::clone(&cause);
        let reports = Rc::clone(&errors);
        options.on_error = Some(Rc::new(move |error, _| match error {
            RuntimeError::Handler(AgentWorkError::Tool(HostFailure::Pause(actual))) => {
                assert!(Rc::ptr_eq(actual, &same));
                assert_eq!(actual.0.get(), 8);
                reports.set(reports.get() + 1);
            }
            RuntimeError::Handler(AgentWorkError::Tool(HostFailure::Io(actual))) => {
                panic!("unexpected IO:{actual}")
            }
            other => panic!("unexpected runtime failure:{other:?}"),
        }));
        let run = runtime::try_launch(wired.machine, (), wired.interpret, wired.subscribe, options);
        run.ready().await.unwrap();
        if round == 1 {
            assert!(Rc::ptr_eq(
                run.get_state().unwrap().as_ref(),
                loaded.as_ref().unwrap()
            ));
            assert_eq!(models.get(), 1);
            assert_eq!(io.get(), 0);
        }
        let message = if round == 0 {
            AgentMachineMsg::Start {
                run_id: "invoice".into(),
                at: 0.0,
            }
        } else {
            agent_boot_msg(17.25)
        };
        let _ = run.dispatch(message).await;
        run.idle().await.unwrap();
        if round == 0 {
            assert_eq!(models.get(), 1);
            assert_eq!(io.get(), 0);
            let state = run.get_state().unwrap();
            assert!(!state.is_settled());
            assert!(Rc::ptr_eq(
                &state.tools.running[0],
                observed.borrow().as_ref().unwrap()
            ));
            loaded = Some(Rc::clone(state.as_ref()));
            drop(external_first.take());
        } else {
            let state = run.done().await.unwrap();
            assert!(state.is_settled());
            assert_eq!(models.get(), 2);
            assert_eq!(io.get(), 1);
            let AgentField::Value(Some(out)) = &state.output else {
                panic!("output")
            };
            assert!(Rc::ptr_eq(out, &last));
        }
        run.stop().await;
    }
    drop(loaded);
    let original = first_owner
        .upgrade()
        .expect("retained call still owns its turn");
    let record = recorded.borrow().as_ref().cloned().unwrap();
    assert!(Rc::ptr_eq(
        &record.call,
        observed.borrow().as_ref().unwrap()
    ));
    assert!(std::ptr::eq(
        record.call.args(),
        raw_args(raw_call(&original))
    ));
    let text = serde_json::to_string(&record).unwrap();
    assert!(text.contains("unknownCall"));
    assert!(text.contains("unknownArg"));
    let restored: ToolRecordOf<PlainData, PlainData, PlainData, PlainCalls> =
        serde_json::from_str(&text).unwrap();
    assert_eq!(restored.call.index(), None);
    assert_eq!(serde_json::to_string(&restored).unwrap(), text);
    let standalone_owner = Rc::downgrade(restored.call.owner());
    drop(restored);
    assert!(standalone_owner.upgrade().is_none());
    let conversation: Conversation<PlainData, PlainData, PlainData, PlainData, PlainCalls> =
        Conversation::fresh();
    let text = serde_json::to_string(&conversation).unwrap();
    let _: Conversation<PlainData, PlainData, PlainData, PlainData, PlainCalls> =
        serde_json::from_str(&text).unwrap();
    assert_eq!(errors.get(), 1);
    drop(original);
    assert!(matches!(record.call.args(), PlainData::Object(_)));
    let pending = agent
        .start(&agent.init(), "manual-refusal", 0.0)
        .unwrap()
        .state;
    let malformed = Rc::new(
        decode_json(
            r#"{"content":"manual missing calls","usage":{"inputTokens":1,"outputTokens":2}}"#,
        )
        .unwrap(),
    );
    let Err(demlik_tea::agent::AgentError::TurnRead(error)) =
        agent.turn(&pending, Rc::clone(&malformed), 1.0)
    else {
        panic!("manual raw projection refuses")
    };
    assert!(Rc::ptr_eq(error.owner(), &malformed));
    assert_eq!(
        error.location,
        demlik_tea::agent::TurnReadLocation::ToolCalls
    );
    std::fs::remove_dir_all(directory).unwrap();
}
fn main() {
    let host = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&host, async {
        consume(Profile::Promise).await;
        consume(Profile::Effect).await;
    });
    println!(
        "agent-turn-interface: guarded root/call/args/view/record/retained Boot and wire passed in both profiles"
    );
}
