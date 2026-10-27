use demlik_tea::{PlainData, agent::{GuardedSchema, PlainCalls, StateOf}, data::JsText};
type State = StateOf<(), JsText, PlainData, GuardedSchema, PlainData, PlainData, PlainData, PlainData, PlainCalls>;
fn serializable<T: serde::Serialize>() {}
fn main() { serializable::<State>(); }
