use std::cell::Cell;
use std::rc::Rc;

use demlik_tea::core::Row;
use demlik_tea::{Machine, Step, Sub, Tagged, Update, fold_msgs};

struct State {
    count: u32,
    local: Rc<Cell<u32>>,
}
impl Tagged for State {
    fn tag(&self) -> &str {
        "(untagged state)"
    }
}
enum Msg {
    Added,
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        "added"
    }
}

#[test]
fn a_prediction_fold_accepts_borrowed_non_clone_non_send_non_serializable_state() {
    let owner = Rc::new(Cell::new(0));
    let borrowed = "the machine may borrow its owner's configuration";
    let machine: Machine<'_, State, Msg, (), Sub> = Machine {
        init: Box::new(|_, _| {
            let _ = borrowed;
            panic!("a prediction fold must bypass init")
        }),
        update: Update::raw_reducer(Row::from([(
            "added".into(),
            Box::new(|state: &State, _: &Msg| {
                Step::new(
                    State {
                        count: state.count + 1,
                        local: Rc::clone(&state.local),
                    },
                    vec![],
                )
            }) as demlik_tea::core::Cell<'_, State, Msg, ()>,
        )])),
        subscriptions: demlik_tea::core::subscriptions(|_| {
            panic!("a prediction fold must bypass subscription projection")
        }),
    };
    let state = fold_msgs(
        &machine,
        State {
            count: 10,
            local: Rc::clone(&owner),
        },
        [Msg::Added],
    )
    .unwrap();
    assert_eq!(state.count, 11);
    assert!(Rc::ptr_eq(&state.local, &owner));
}
