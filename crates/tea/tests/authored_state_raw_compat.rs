use std::{
    cell::{Cell, RefCell},
    panic::{AssertUnwindSafe, catch_unwind},
    rc::Rc,
    sync::{Arc, atomic::AtomicUsize},
};

use demlik_tea::{Step, Tagged, Update, core::Row};

struct State {
    name: Cell<&'static str>,
    log: Rc<RefCell<Vec<String>>>,
}
impl Tagged for State {
    fn tag(&self) -> &str {
        self.log.borrow_mut().push("state".into());
        self.name.get()
    }
}
struct Wire {
    name: &'static str,
    log: Rc<RefCell<Vec<String>>>,
}
impl Tagged for Wire {
    fn tag(&self) -> &str {
        self.log.borrow_mut().push(format!("msg:{}", self.name));
        self.name
    }
}
fn row(log: &Rc<RefCell<Vec<String>>>) -> Row<'static, State, Wire, ()> {
    let log = Rc::clone(log);
    Row::from([(
        "Known".into(),
        Box::new(move |state: &State, _: &Wire| {
            log.borrow_mut().push("cell".into());
            Step::new(
                State {
                    name: Cell::new(state.name.get()),
                    log: Rc::clone(&state.log),
                },
                vec![],
            )
        }) as _,
    )])
}

#[test]
fn raw_tables_read_the_current_tag_only_at_the_existing_lookup_and_refusal_points() {
    for transitions in [false, true] {
        let log = Rc::new(RefCell::new(Vec::new()));
        let state = State {
            name: Cell::new("ready"),
            log: Rc::clone(&log),
        };
        let update = if transitions {
            Update::raw_transitions(indexmap::IndexMap::from([("ready".into(), row(&log))]))
        } else {
            Update::raw_reducer(row(&log))
        };
        assert!(
            log.borrow().is_empty(),
            "construction must retain an accessor, not read a tag"
        );
        assert!(update.accepted_types(None).is_empty());
        assert!(log.borrow().is_empty());
        assert_eq!(update.accepted_types(Some(&state)), ["Known"]);
        assert_eq!(
            *log.borrow(),
            if transitions { vec!["state"] } else { vec![] }
        );
        log.borrow_mut().clear();
        let known = Wire {
            name: "Known",
            log: Rc::clone(&log),
        };
        assert!(update.apply(&state, &known).is_ok());
        assert_eq!(
            *log.borrow(),
            if transitions {
                vec!["state", "msg:Known", "cell"]
            } else {
                vec!["msg:Known", "cell"]
            }
        );
        log.borrow_mut().clear();
        let missing = Wire {
            name: "Missing",
            log: Rc::clone(&log),
        };
        let Err(error) = update.apply(&state, &missing) else {
            panic!("missing wire cell was accepted")
        };
        assert_eq!(error.msg_type, "Missing");
        assert_eq!(error.state_name, "ready");
        assert_eq!(error.accepted_types, ["Known"]);
        assert_eq!(
            error.message,
            "@demlik/tea: no update cell for msg.type \"Missing\" in state \"ready\" — the machine's update does not handle this Msg (an unknown wire msg.type, or a missing cell reached by bypassing the mapped types). This state accepts: \"Known\"."
        );
        assert_eq!(
            *log.borrow(),
            if transitions {
                vec!["state", "msg:Missing", "msg:Missing", "state", "state"]
            } else {
                vec!["msg:Missing", "msg:Missing", "state"]
            }
        );
        log.borrow_mut().clear();
        state.name.set("waiting");
        let result = update.apply(&state, &known);
        if transitions {
            let Err(error) = result else {
                panic!("transition used a captured old tag")
            };
            assert_eq!(error.state_name, "waiting");
            assert!(error.accepted_types.is_empty());
            assert_eq!(*log.borrow(), ["state", "msg:Known", "state", "state"]);
        } else {
            assert!(result.is_ok());
            assert_eq!(*log.borrow(), ["msg:Known", "cell"]);
        }
    }
}

struct PanickingState(Arc<AtomicUsize>);
impl Tagged for PanickingState {
    fn tag(&self) -> &str {
        std::panic::panic_any(Arc::clone(&self.0))
    }
}
#[test]
fn raw_transition_tag_panics_retain_the_original_payload() {
    let original = Arc::new(AtomicUsize::new(9));
    let update: Update<'_, PanickingState, Wire, ()> = Update::raw_transitions(Default::default());
    let wire = Wire {
        name: "Known",
        log: Rc::new(RefCell::new(Vec::new())),
    };
    let Err(payload) = catch_unwind(AssertUnwindSafe(|| {
        update.apply(&PanickingState(Arc::clone(&original)), &wire)
    })) else {
        panic!("tag panic was changed into another outcome")
    };
    assert!(Arc::ptr_eq(
        payload.downcast_ref::<Arc<AtomicUsize>>().unwrap(),
        &original
    ));
}
