use demlik_tea::{PlainData, agent::{GuardedSchema, PlainCalls, StateOf}, data::JsText};
type State = StateOf<(), JsText, PlainData, GuardedSchema, PlainData, PlainData, PlainData, PlainData, PlainCalls>;
fn decodable<T: serde::de::DeserializeOwned>() {}
fn main() { decodable::<State>(); }
