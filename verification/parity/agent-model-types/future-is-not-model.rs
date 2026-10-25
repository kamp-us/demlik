use demlik_tea::{agent::{model::{model_factory, ModelFactory}, types::AGENT_TURN_SCHEMA, GuardedSchema, StructuredOutputError}, resilience::resilient_call::CallValue};
fn accepts(_:impl ModelFactory<(),GuardedSchema>){}
fn main(){
    let _=AGENT_TURN_SCHEMA;
    let model=model_factory(|_|Ok::<_,CallValue<StructuredOutputError>>(std::future::ready(())));
    accepts(model);
}
