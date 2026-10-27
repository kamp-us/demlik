//! Local construction/pure folding admits borrowed services and state-only data.
use demlik_tea::{
    PlainData, Tagged,
    agent::{
        AgentCommand, AgentConfig, AgentMachineMsg, AgentToolMsg, AgentWorkError, agent_boot_msg,
        create_agent,
        model::{BrainPorts, Llm, MessageLoader, Messages, ModelFactory, brain_handler},
        types::{AgentTurn, Conversation},
    },
    command::{CommandContractError, CommandFamily},
    core::try_fold_updates,
    llm_call::{self, LlmCall, Request, Schema},
    resilience::resilient_call::CallValue,
    runtime::NoInterpreter,
    timing::TokioTimer,
};
use std::{cell::Cell, convert::Infallible, ops::AsyncFn, rc::Rc};
struct Stage<'a>(&'a Cell<u32>);
struct Cause;
type Turn = AgentTurn<(), ()>;
struct Parser<'a>(&'a Cell<u32>);
impl Schema for Parser<'_> {
    type Raw = Rc<Turn>;
    type Output = Rc<Turn>;
    type Error = Cause;
    fn parse(&self, v: Self::Raw) -> Result<Self::Output, CallValue<Cause>> {
        self.0.set(self.0.get() + 1);
        Ok(v)
    }
}
struct Factory<'a>(&'a Cell<u32>);
struct Client<'a>(&'a Cell<u32>);
impl<'f, 's> ModelFactory<(), Parser<'s>> for Factory<'f> {
    fn model_of(
        &self,
        _: Option<&demlik_tea::data::JsText>,
    ) -> Result<impl Llm<(), Parser<'s>>, CallValue<Cause>> {
        Ok(Client(self.0))
    }
}
impl<'f, 's> Llm<(), Parser<'s>> for Client<'f> {
    fn with_structured_output<'a>(
        &'a self,
        _: &'a Parser<'s>,
    ) -> Result<
        impl for<'m> AsyncFn(Messages<'m, ()>) -> Result<Rc<Turn>, CallValue<Cause>> + 'a,
        CallValue<Cause>,
    > {
        Ok(async move |_: Messages<'_, ()>| {
            self.0.set(self.0.get() + 1);
            Ok(Rc::new(Turn::new("local turn".into(), vec![])))
        })
    }
}
struct Loader<'a>(&'a Cell<u32>);
impl<'p, 'l> MessageLoader<&'p str, (), (), Cause> for Loader<'l> {
    async fn load<'a>(
        &'a self,
        _: &'a Rc<Request<&'p str, ()>>,
    ) -> Result<Messages<'a, ()>, CallValue<Cause>>
    where
        (): 'a,
    {
        self.0.set(self.0.get() + 1);
        Ok(Messages::Borrowed(&[]))
    }
}
struct Tool;
impl Tagged for Tool {
    fn tag(&self) -> &str {
        "tool"
    }
}
impl CommandFamily for Tool {
    type Msg = AgentToolMsg<()>;
    type Completion = Vec<Self::Msg>;
    fn settle(self, v: Self::Completion, _: f64) -> Result<Vec<Self::Msg>, CommandContractError> {
        Ok(v)
    }
}
async fn consume() {
    let counter = Cell::new(0);
    let parser = Rc::new(Parser(&counter));
    let schema = Rc::clone(&parser);
    let llm = Rc::new(LlmCall::new(
        llm_call::Config::new(move |_: &&str| Rc::clone(&schema)),
        |_: &Cause| Ok("rejected".into()),
    ));
    let stage = Rc::new(Stage(&counter));
    let agent = Rc::new(create_agent(AgentConfig::new(
        Rc::clone(&llm),
        vec![Rc::clone(&stage)],
        |_| "invoice",
        |_| Tool,
        |_, _: &Rc<Conversation<(), Turn, PlainData, ()>>, _| (),
        |turn| turn,
    )));
    let wired = Rc::clone(&agent).to_machine(
        Factory(&counter),
        Loader(&counter),
        NoInterpreter::<AgentWorkError<Infallible>>::new(),
        Rc::new(TokioTimer::new(|_| {})),
    );
    // BORROWED_ACTOR_PROBE: inserting try_launch here must refuse these local owners.
    let initial = (wired.machine.init)(None, &());
    let started = wired
        .machine
        .update
        .try_apply(
            &initial.state,
            &AgentMachineMsg::Start {
                run_id: "local".into(),
                at: 0.0,
            },
        )
        .unwrap();
    assert!(std::ptr::eq(
        started.state.current_stage().unwrap().0,
        &counter
    ));
    let folded = try_fold_updates(
        &wired.machine.update,
        Rc::clone(&started.state),
        [agent_boot_msg(2.0)],
    )
    .unwrap();
    assert!(Rc::ptr_eq(&folded.state.current_stage().unwrap(), &stage));
    let AgentCommand::Brain(cmd) = &started.commands[0] else {
        unreachable!()
    };
    let factory = Factory(&counter);
    let loader = Loader(&counter);
    let handler = brain_handler(llm.as_ref(), BrainPorts::new(&factory).with_loader(&loader));
    assert!(handler.handle(cmd).await.is_ok());
    assert_eq!(counter.get(), 3);
}
fn main() {
    futures::executor::block_on(consume());
    println!(
        "borrowed model/loader/schema and state-only stage: local construction/fold/brain passed"
    );
}
