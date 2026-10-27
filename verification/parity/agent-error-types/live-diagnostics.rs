use demlik_tea::{PlainData, agent::{StructuredOutputError, types::AGENT_TURN_SCHEMA}, llm_call::{Schema,Config,LlmCall}, resilience::resilient_call::CallValue};
use std::rc::Rc;
fn main() {
    let schema=Rc::new(AGENT_TURN_SCHEMA);
    let original=Rc::new(PlainData::Null);
    let Err(CallValue::Shared(error))=schema.parse(Rc::clone(&original)) else {panic!("guard")};
    let StructuredOutputError::Live(live)=error.as_ref() else {panic!("live")};
    let standard:&dyn std::error::Error=live;
    assert_eq!(standard.to_string(),"structured-output parse failed: not an AgentTurn");
    assert!(Rc::ptr_eq(live.value(),&original));
    let _:LlmCall<'_,&str,(),_>=LlmCall::new(Config::new(move |_|Rc::clone(&schema)),StructuredOutputError::describe);
}
