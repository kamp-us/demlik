#![allow(
    clippy::arc_with_non_send_sync,
    reason = "The local runtime retains Arc handles without requiring Send; these borrowed opaque values enforce that contract."
)]

use demlik_tea::{Machine, Step, Sub, Tagged, Update, fold_msgs_shared, fold_updates_shared};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};
struct State<'a> {
    count: u32,
    name: &'a str,
    local: Rc<Cell<u32>>,
}
impl Tagged for State<'_> {
    fn tag(&self) -> &str {
        "state"
    }
}
struct Msg<'a> {
    kind: &'a str,
    name: &'a str,
    by: u32,
    local: Rc<Cell<u32>>,
}
impl Tagged for Msg<'_> {
    fn tag(&self) -> &str {
        self.kind
    }
}
struct Cmd<'a> {
    name: &'a str,
    local: Rc<Cell<u32>>,
}
fn machine<'a>(
    calls: &'a Cell<u32>,
    pointers: &'a RefCell<Vec<*const Msg<'a>>>,
) -> Machine<'a, State<'a>, Msg<'a>, Cmd<'a>, Sub> {
    let mut row: demlik_tea::core::Row<'a, State<'a>, Msg<'a>, Cmd<'a>> = Default::default();
    row.insert(
        "add".into(),
        Box::new(move |state, msg| {
            calls.set(calls.get() + 1);
            pointers.borrow_mut().push(msg as *const _);
            Step::new(
                State {
                    count: state.count + msg.by,
                    name: state.name,
                    local: state.local.clone(),
                },
                vec![Cmd {
                    name: msg.name,
                    local: msg.local.clone(),
                }],
            )
        }),
    );
    Machine {
        init: Box::new(|_, _| panic!("retained replay must not initialize")),
        update: Update::raw_reducer(row),
        subscriptions: demlik_tea::core::subscriptions(|_| {
            panic!("retained replay must not select subscriptions")
        }),
    }
}
#[test]
fn shared_fold_keeps_opaque_borrowed_values_and_original_message_handles_without_initializing() {
    let name = String::from("borrowed");
    let calls = Cell::new(0);
    let pointers = RefCell::new(vec![]);
    let machine = machine(&calls, &pointers);
    let local = Rc::new(Cell::new(7));
    let seed = Arc::new(State {
        count: 10,
        name: &name,
        local: local.clone(),
    });
    let msgs = [1, 2, 3].map(|by| {
        Arc::new(Msg {
            kind: "add",
            name: &name,
            by,
            local: local.clone(),
        })
    });
    let result = fold_updates_shared(&machine.update, seed.clone(), msgs.iter().cloned()).unwrap();
    assert_eq!(result.state.count, 16);
    assert_eq!(result.state.name, "borrowed");
    assert_eq!(seed.count, 10);
    assert!(!Arc::ptr_eq(&seed, &result.state));
    assert!(Rc::ptr_eq(&seed.local, &result.state.local));
    assert_eq!(
        &*pointers.borrow(),
        &msgs.iter().map(Arc::as_ptr).collect::<Vec<_>>()
    );
    assert_eq!(
        result
            .commands
            .iter()
            .map(|cmd| cmd.name)
            .collect::<Vec<_>>(),
        vec!["borrowed"; 3]
    );
    assert!(
        result
            .commands
            .iter()
            .all(|cmd| Rc::ptr_eq(&cmd.local, &local))
    );
    assert_eq!(calls.get(), 3);
    let replayed = fold_msgs_shared(&machine, seed, msgs).unwrap();
    assert_eq!(replayed.count, 16);
    assert_eq!(calls.get(), 6);
    local.set(9);
    assert_eq!(replayed.local.get(), 9);
}
#[test]
fn an_empty_shared_fold_returns_the_exact_seed_arc() {
    let name = String::from("seed");
    let calls = Cell::new(0);
    let pointers = RefCell::new(vec![]);
    let machine = machine(&calls, &pointers);
    let seed = Arc::new(State {
        count: 2,
        name: &name,
        local: Rc::new(Cell::new(0)),
    });
    let result = fold_updates_shared(&machine.update, seed.clone(), std::iter::empty()).unwrap();
    assert!(Arc::ptr_eq(&result.state, &seed));
    assert!(result.commands.is_empty());
    assert!(Arc::ptr_eq(
        &fold_msgs_shared(&machine, seed.clone(), []).unwrap(),
        &seed
    ));
    assert_eq!(calls.get(), 0);
}
#[test]
fn a_missing_cell_returns_the_original_contract_error_and_stops_the_fold() {
    let name = String::from("error");
    let calls = Cell::new(0);
    let pointers = RefCell::new(vec![]);
    let machine = machine(&calls, &pointers);
    let local = Rc::new(Cell::new(0));
    let seed = Arc::new(State {
        count: 0,
        name: &name,
        local: local.clone(),
    });
    let messages = ["add", "missing", "add"].map(|kind| {
        Arc::new(Msg {
            kind,
            name: &name,
            by: 1,
            local: local.clone(),
        })
    });
    let error = match fold_msgs_shared(&machine, seed.clone(), messages) {
        Ok(_) => panic!("missing cell must refuse"),
        Err(error) => error,
    };
    assert_eq!(error.msg_type, "missing");
    assert_eq!(error.state_name, "state");
    assert_eq!(error.accepted_types, vec!["add"]);
    assert_eq!(error.name(), "NoCellError");
    assert_eq!(calls.get(), 1);
    assert_eq!(seed.count, 0);
}
