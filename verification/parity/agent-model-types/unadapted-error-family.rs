use demlik_tea::{agent::{model::{brain_handler, plain_model, BrainPorts, Messages}, types::AGENT_TURN_SCHEMA, StructuredOutputError}, llm_call::{Config, LlmCall}, resilience::resilient_call::CallValue, PlainData};
use std::{cell::Cell, rc::Rc};
struct OpaqueFailure<'a>(&'a Cell<u8>);
fn main() {
    let context=Cell::new(7);
    let original=Rc::new(OpaqueFailure(&context));
    let schema=Rc::new(AGENT_TURN_SCHEMA);
    let llm:LlmCall<'_,&str,(),_>=LlmCall::new(Config::new(move|_|Rc::clone(&schema)),|_:&StructuredOutputError|Ok("schema".into()));
    let model=plain_model(async |_:Messages<'_,()>| ->Result<Rc<PlainData>,CallValue<OpaqueFailure<'_>>> {Err(CallValue::shared(Rc::clone(&original)))});
    let _=brain_handler(&llm,BrainPorts::new(&model));
}
