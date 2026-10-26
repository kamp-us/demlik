use demlik_tea::agent::types::{AgentEndedStatus, AgentField, AgentNumber, TurnUsage};
use std::rc::Rc;
fn main() {
    let _: AgentEndedStatus<(), ()> = AgentEndedStatus::Cancelled {
        at: AgentNumber(None),
    };
    let _: AgentEndedStatus<(), ()> = AgentEndedStatus::Failed {
        failure: AgentField::Undefined,
    };
    let _: AgentEndedStatus<(), ()> = AgentEndedStatus::Done {
        output: AgentField::Undefined,
        usage: Rc::new(TurnUsage::new(0.0, 0.0)),
    };
}
