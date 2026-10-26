use demlik_tea::agent::types::AgentEndedStatus;
fn main() {
    let value: AgentEndedStatus<(), ()> = AgentEndedStatus::Cancelled { at: 0.0.into() };
    match value {
        AgentEndedStatus::Done { .. } | AgentEndedStatus::Failed { .. } => {}
    }
}
