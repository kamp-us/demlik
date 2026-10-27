//! Compiled public consumer: opaque owned payloads/cause and independent tool/host messages.
use demlik_tea::{
    PlainData, Tagged,
    agent::{
        AgentCompletion, AgentConfig, AgentMachineMsg, AgentToolMsg, AgentWorkError, create_agent,
        model::{Messages, NoMessages, plain_model},
        types::{AgentTurn, Conversation, ToolCall},
    },
    command::{CommandContractError, CommandEdge, CommandFamily, Failure, Outcome, Settlement},
    llm_call::{self, CauseField, LlmCall, Rejected, Schema},
    resilience::resilient_call::{CallValue, RunError},
    runtime::{self, CommandContext, CommandWork, Interpreter, Options, Profile},
    storage::{Migrated, Store},
    timing::TokioTimer,
};
use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    convert::Infallible,
    rc::Rc,
};

struct Args;
struct Payload;
struct ResultValue(Rc<Cell<u32>>);
struct Cause(Rc<Cell<u32>>);
struct HostFailure;
type Turn = AgentTurn<Args, ()>;
struct Parser;
impl Schema for Parser {
    type Raw = Rc<Turn>;
    type Output = Rc<Turn>;
    type Error = Cause;
    fn parse(&self, raw: Rc<Turn>) -> Result<Rc<Turn>, CallValue<Cause>> {
        Ok(raw)
    }
}
struct Tool(Rc<ToolCall<Args>>);
impl Tagged for Tool {
    fn tag(&self) -> &str {
        "invoice_tool"
    }
}
impl CommandFamily for Tool {
    type Msg = AgentToolMsg<ResultValue>;
    type Completion = Vec<Self::Msg>;
    fn settle(
        self,
        messages: Self::Completion,
        _: f64,
    ) -> Result<Vec<Self::Msg>, CommandContractError> {
        Ok(messages)
    }
}
type HostMsg = AgentMachineMsg<&'static str, Payload, Rc<Turn>, Cause, AgentToolMsg<ResultValue>>;
struct Tools {
    result: Rc<ResultValue>,
    cleanups: Rc<Cell<u32>>,
    tails: Rc<Cell<u32>>,
}
impl Interpreter<Tool, HostMsg> for Tools {
    type Error = AgentWorkError<HostFailure>;
    fn interpret<'a>(
        &'a self,
        cmd: &'a Tool,
        ctx: CommandContext<HostMsg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<AgentToolMsg<ResultValue>>, Self::Error>> {
        Some(
            CommandWork::new(async move {
                let tail = Rc::clone(&self.tails);
                ctx.wait_until(async move {
                    tail.set(tail.get() + 1);
                    Ok(())
                });
                ctx.dispatch(AgentMachineMsg::Tool(AgentToolMsg::Ok {
                    call_id: cmd.0.call_id.clone(),
                    result: Rc::clone(&self.result),
                    at: 17.25,
                }))
                .unwrap();
                Ok(vec![])
            })
            .with_cleanup(move || {
                self.cleanups.set(self.cleanups.get() + 1);
                async { Ok(()) }
            }),
        )
    }
}
struct Saved<S>(Rc<RefCell<Option<Rc<S>>>>);
impl<S> Store<Rc<S>> for Saved<S> {
    type Raw = Option<Rc<S>>;
    type Error = Infallible;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        Ok(self.0.borrow().clone())
    }
    async fn save(&self, state: &Rc<S>) -> Result<(), Self::Error> {
        self.0.replace(Some(Rc::clone(state)));
        Ok(())
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<Rc<S>> {
        raw.map_or(Migrated::Fresh, Migrated::State)
    }
}
async fn consume(profile: Profile) {
    let token = Rc::new(Cell::new(7));
    let original_cause = Rc::new(Cause(Rc::clone(&token)));
    assert!(Rc::ptr_eq(&original_cause.0, &token));
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(|_: &&str| Rc::new(Parser)),
        |cause: &Cause| Ok(format!("cause:{}", cause.0.get()).into()),
    ));
    let agent = Rc::new(create_agent(AgentConfig::new(
        llm,
        vec![Rc::new("collect")],
        |_| "invoice",
        |call| Tool(Rc::clone(call)),
        |_, _: &Rc<Conversation<ResultValue, Turn, PlainData, Args>>, _| Payload,
        |turn| turn,
    )));
    let mut started = agent.start(&agent.init(), "identity-proof", 0.0).unwrap();
    let command = started.commands.pop().unwrap();
    let edge = CommandEdge::new(|| 17.25);
    let guard = command.dispatch_guard(&edge);
    let mut settled = command
        .settle_in(
            AgentCompletion::Brain(Some(Outcome::err(RunError::port_rejected(Rejected::new(
                CallValue::shared(Rc::clone(&original_cause)),
            ))))),
            &edge,
        )
        .unwrap();
    let message = settled.pop().unwrap();
    assert!(guard.check(&message).is_ok());
    let AgentMachineMsg::Brain(msg) = message else {
        unreachable!()
    };
    assert_eq!(msg.engine_stamp().unwrap().at(), 17.25);
    let Settlement::Err(Failure::Declared(error)) = msg.outcome() else {
        unreachable!()
    };
    let CauseField::Own(CallValue::Shared(cause)) = error.details.cause() else {
        unreachable!()
    };
    assert!(Rc::ptr_eq(cause, &original_cause));
    let call = Rc::new(ToolCall {
        call_id: "read-invoice".into(),
        name: "collect".into(),
        args: Rc::new(Args),
    });
    let replies = Rc::new(RefCell::new(VecDeque::from([
        Rc::new(Turn::new("collect invoice".into(), vec![call])),
        Rc::new(Turn::new("collected".into(), vec![])),
    ])));
    let model = plain_model(
        async move |_: Messages<'_, ()>| -> Result<Rc<Turn>, CallValue<Cause>> {
            Ok(replies
                .borrow_mut()
                .pop_front()
                .expect("only the two authored turns"))
        },
    );
    let cleanups = Rc::new(Cell::new(0));
    let tails = Rc::new(Cell::new(0));
    let result = Rc::new(ResultValue(Rc::clone(&token)));
    let tools = Tools {
        result: Rc::clone(&result),
        cleanups: Rc::clone(&cleanups),
        tails: Rc::clone(&tails),
    };
    let timer = Rc::new(TokioTimer::with_clock(|| 17.25, |_| {}));
    // No model/state/cause generic arguments or trait bounds at the call.
    let wired = Rc::clone(&agent).to_machine(model, NoMessages, tools, timer);
    let saved = Rc::new(RefCell::new(None));
    let mut options = Options::new(profile);
    options.store = Some(runtime::Persistence::new(Saved(Rc::clone(&saved))));
    let terminal = Rc::clone(&agent);
    options.terminal = Some(Rc::new(move |s| terminal.is_settled(s)));
    options.clock = Rc::new(|| 17.25);
    let run = runtime::try_launch(wired.machine, (), wired.interpret, wired.subscribe, options);
    run.ready().await.unwrap();
    let initial = run.get_state().unwrap();
    assert!(Rc::ptr_eq(
        initial.as_ref(),
        saved.borrow().as_ref().unwrap()
    ));
    run.dispatch(AgentMachineMsg::Start {
        run_id: "invoice-17".into(),
        at: 0.0,
    })
    .await
    .unwrap();
    let final_state = run.done().await.unwrap();
    assert!(agent.is_settled(&final_state));
    assert_eq!(cleanups.get(), 1);
    assert_eq!(tails.get(), 1);
    assert!(Rc::ptr_eq(&result.0, &token));
    run.stop().await;
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
    println!("agent-runtime-interface: Promise/Effect opaque caller and host dispatch passed");
}
