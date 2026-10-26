use demlik_tea::{
    PlainData,
    agent::{
        ProjectedStatus, status,
        types::{AgentState, AgentTurn},
    },
};
pub fn escape<'a>(
    state: AgentState<(), (), (), ()>,
) -> ProjectedStatus<'a, (), AgentTurn, PlainData, PlainData, PlainData> {
    status(&state)
}
fn main() {}
