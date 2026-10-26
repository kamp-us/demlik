use demlik_tea::agent::AgentStatus;
fn main() {
    let value: AgentStatus<'_, (), (), ()> = AgentStatus::Idle;
    match value {
        AgentStatus::Running | AgentStatus::Suspended { .. } | AgentStatus::Ended(_) => {}
    }
}
