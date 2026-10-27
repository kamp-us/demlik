use demlik_tea::{PlainData,agent::StructuredOutputRejection};
use std::rc::Rc;
fn main() { let _ = StructuredOutputRejection { value: Rc::new(PlainData::Null), expected: "invented" }; }
