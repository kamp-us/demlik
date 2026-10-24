use demlik_tea::{Step, Tagged, Update, messages};

messages! { enum Msg { Added { by: u32 }, Reset } }
struct State(u32);
impl Tagged for State {
    fn tag(&self) -> &str {
        "(untagged state)"
    }
}

#[test]
fn typed_reducer_derives_acceptance_from_its_message_enum() {
    let update: Update<'_, State, Msg, ()> = Update::reducer(|state: &State, msg| match msg {
        Msg::Added { by } => Step::new(State(state.0 + by), vec![]),
        Msg::Reset => Step::new(State(0), vec![]),
    });
    let state = State(7);
    assert_eq!(update.accepted_types(Some(&state)), ["Added", "Reset"]);
    assert!(update.accepted_types(None).is_empty());
    assert_eq!(
        update.apply(&state, &Msg::Added { by: 2 }).unwrap().state.0,
        9
    );
    assert_eq!(update.apply(&state, &Msg::Reset).unwrap().state.0, 0);
}
