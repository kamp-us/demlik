use demlik_tea::{
    PlainData,
    agent::{
        DefineAgentConfig, DefinedAgentRunOptions, DefinedAgentState, define_agent,
        defined::{DefinedAgentMessage, DefinedAgentModelError},
        model::{Messages, plain_model},
        tool::EmptyRouter,
        types::{AgentFailure, AgentField},
    },
    llm_call::LlmCause,
    resilience::resilient_call::CallValue,
    runtime::DriveError,
    timing::TokioTimer,
};
use std::{cell::RefCell, convert::Infallible, rc::Rc};

// Deliberately neither Clone, Debug, Display, Serialize nor Send/Sync.
struct OpaqueProviderFailure {
    nested: Rc<RefCell<Box<u32>>>,
}
type Error = DefinedAgentModelError<Infallible, OpaqueProviderFailure>;
type State = Rc<DefinedAgentState<EmptyRouter, OpaqueProviderFailure>>;

#[test]
fn no_tool_provider_failure_keeps_opaque_owners_through_drive_and_semantic_event() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&runtime, async {
        let nested = Rc::new(RefCell::new(Box::new(17)));
        let original = Rc::new(Error::Provider(OpaqueProviderFailure { nested: Rc::clone(&nested) }));
        let cause = Rc::clone(&original);
        let model = plain_model(async move |_: Messages<'_, DefinedAgentMessage<EmptyRouter>>| -> Result<Rc<PlainData>, CallValue<Error>> {
            Err(CallValue::Shared(Rc::clone(&cause)))
        });
        let agent = define_agent(DefineAgentConfig::new(model, Rc::new(EmptyRouter), "Keep failures."));
        // The portable interface also accepts the opaque error, independently of serialization.
        let wired = agent.machine("Try once.".into(), Rc::new(()), Rc::new(TokioTimer::new(|_| {})));
        let initial = (wired.machine.init)(None, &());
        assert!(matches!(initial.state.failure, AgentField::Value(None)));
        let observed = Rc::new(RefCell::new(Vec::<Rc<Error>>::new()));
        let events = Rc::clone(&observed);
        let result = agent.run("Try once.", DefinedAgentRunOptions::new(Rc::new(())).on_event(move |event| {
            if let demlik_tea::agent::types::AgentEvent::RunDone { status, .. } = event {
                let demlik_tea::agent::types::AgentEndedStatus::Failed { failure: AgentField::Value(failure) } = status.as_ref() else { panic!("failed status") };
                let demlik_tea::agent::types::AgentTerminalFailure::Agent(failure) = failure.as_ref() else { panic!("agent failure") };
                let AgentFailure::Llm { error: AgentField::Value(error), .. } = failure.as_ref() else { panic!("llm failure") };
                let LlmCause::Value(cause) = &error.error else { panic!("typed cause") };
                let Error::Provider(value) = cause.as_ref() else { panic!("provider failure") };
                assert_eq!(**value.nested.borrow(), 17);
                assert_eq!(error.reason.as_utf8(), Some("model provider failed"));
                events.borrow_mut().push(Rc::clone(cause));
            }
        })).await;
        assert_eq!(observed.borrow().len(), 1);
        assert!(Rc::ptr_eq(&observed.borrow()[0], &original));
        let state: State = match result { Err(DriveError::Failed { state }) => Rc::clone(&state), _ => panic!("ordinary failed drive") };
        let AgentField::Value(Some(failure)) = &state.failure else { panic!("canonical failure") };
        let AgentFailure::Llm { error: AgentField::Value(error), .. } = failure.as_ref() else { panic!("llm failure") };
        let LlmCause::Value(cause) = &error.error else { panic!("original cause") };
        assert!(Rc::ptr_eq(cause, &original));
        let Error::Provider(value) = cause.as_ref() else { panic!("provider failure") };
        assert!(Rc::ptr_eq(&value.nested, &nested));
        **nested.borrow_mut() = 23;
        assert_eq!(**value.nested.borrow(), 23);
    });
}
