use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::runtime::{
    ErrorPhase, NoInterpreter, NoSubscriptions, Options, Profile, Runtime, launch,
};
use demlik_tea::{Machine, Step, Sub, Tagged, Update, messages};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
    sync::Arc,
};

struct State {
    count: u32,
    shared: Rc<Cell<u32>>,
}
impl Tagged for State {
    fn tag(&self) -> &str {
        "state"
    }
}
messages! { enum Msg { Add { by: u32, shared: Rc<Cell<u32>> } } }
enum Cmd {}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match *self {}
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, _: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        match self {}
    }
}
type Handle = Runtime<State, Msg, Infallible, Infallible>;
fn machine(shared: Rc<Cell<u32>>) -> Machine<'static, State, Msg, Cmd, Sub> {
    Machine {
        init: Box::new(move |_, _| {
            Step::new(
                State {
                    count: 0,
                    shared: shared.clone(),
                },
                vec![],
            )
        }),
        update: Update::reducer(|state: &State, msg| match msg {
            Msg::Add { by, .. } => Step::new(
                State {
                    count: state.count + by,
                    shared: state.shared.clone(),
                },
                vec![],
            ),
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    }
}
fn runtime(profile: Profile, shared: Rc<Cell<u32>>) -> Handle {
    launch(
        machine(shared),
        (),
        NoInterpreter::new(),
        NoSubscriptions::new(),
        Options::new(profile),
    )
}
async fn mixed_order(profile: Profile) {
    let state_token = Rc::new(Cell::new(7));
    let rt = runtime(profile, state_token.clone());
    let log = Rc::new(RefCell::new(Vec::new()));
    let boot = Rc::new(RefCell::new(None));
    let a = log.clone();
    let off_a = rt.on_boot(move |_| a.borrow_mut().push("boot.borrowed"));
    let b = log.clone();
    let captured_boot = boot.clone();
    let off_b = rt.on_boot_retained(move |state| {
        b.borrow_mut().push("boot.retained");
        *captured_boot.borrow_mut() = Some(Arc::clone(state));
    });
    let off_bad = rt.on_boot_retained(|_| panic!("retained boot failed"));
    let d = log.clone();
    let off_d = rt.on_boot(move |_| d.borrow_mut().push("boot.after"));
    rt.ready().await.unwrap();
    assert_eq!(
        &*log.borrow(),
        &["boot.borrowed", "boot.retained", "boot.after"]
    );
    assert!(Arc::ptr_eq(
        boot.borrow().as_ref().unwrap(),
        &rt.get_state().unwrap()
    ));
    let late = Rc::new(RefCell::new(None));
    let late_in = late.clone();
    let off_late =
        rt.on_boot_retained(move |state| *late_in.borrow_mut() = Some(Arc::clone(state)));
    assert!(Arc::ptr_eq(
        late.borrow().as_ref().unwrap(),
        &rt.get_state().unwrap()
    ));
    let original = Rc::new(RefCell::new(Vec::new()));
    let observed = original.clone();
    let a = log.clone();
    let stop_a = rt.observe(move |msg, state| {
        a.borrow_mut().push("step.borrowed");
        observed
            .borrow_mut()
            .push((msg as *const Msg, state as *const State));
    });
    let kept = Rc::new(RefCell::new(Vec::new()));
    let kept_in = kept.clone();
    let b = log.clone();
    let stop_b = rt.observe_retained(move |msg, state| {
        b.borrow_mut().push("step.retained");
        kept_in
            .borrow_mut()
            .push((Arc::clone(msg), Arc::clone(state)));
    });
    let stop_bad = rt.observe_retained(|_, _| panic!("retained observer failed"));
    let d = log.clone();
    let stop_d = rt.observe(move |_, _| d.borrow_mut().push("step.after"));
    let msg_token = Rc::new(Cell::new(13));
    for by in [1, 2, 3] {
        rt.dispatch(Msg::Add {
            by,
            shared: msg_token.clone(),
        })
        .await
        .unwrap();
    }
    let expected = [
        "boot.borrowed",
        "boot.retained",
        "boot.after",
        "step.borrowed",
        "step.retained",
        "step.after",
        "step.borrowed",
        "step.retained",
        "step.after",
        "step.borrowed",
        "step.retained",
        "step.after",
    ];
    assert_eq!(&*log.borrow(), &expected);
    for ((msg, state), (msg_ptr, state_ptr)) in kept.borrow().iter().zip(original.borrow().iter()) {
        assert_eq!(Arc::as_ptr(msg), *msg_ptr);
        assert_eq!(Arc::as_ptr(state), *state_ptr);
        assert!(Rc::ptr_eq(&state.shared, &state_token));
        let Msg::Add { shared, .. } = msg.as_ref();
        assert!(Rc::ptr_eq(shared, &msg_token));
    }
    assert!(Arc::ptr_eq(
        &kept.borrow().last().unwrap().1,
        &rt.get_state().unwrap()
    ));
    state_token.set(9);
    msg_token.set(17);
    assert!(
        kept.borrow()
            .iter()
            .all(|(msg, state)| state.shared.get() == 9
                && matches!(msg.as_ref(), Msg::Add {shared, ..} if shared.get() == 17))
    );
    let reports = rt.reports();
    assert_eq!(reports.len(), 4);
    assert_eq!(reports[0].phase, ErrorPhase::Boot);
    assert!(
        matches!(reports[0].error.as_ref(), demlik_tea::runtime::RuntimeError::Panic(cause) if cause.summary == "retained boot failed")
    );
    assert!(reports[1..].iter().all(|report| matches!(report.error.as_ref(), demlik_tea::runtime::RuntimeError::Panic(cause) if cause.summary == "retained observer failed")));
    assert!(
        reports[1..]
            .iter()
            .all(|report| report.phase == ErrorPhase::Observer)
    );
    for stop in [
        off_a, off_b, off_bad, off_d, off_late, stop_a, stop_b, stop_bad, stop_d,
    ] {
        stop();
        stop();
    }
    let count = log.borrow().len();
    rt.dispatch(Msg::Add {
        by: 10,
        shared: msg_token.clone(),
    })
    .await
    .unwrap();
    assert_eq!(log.borrow().len(), count);
    assert_eq!(kept.borrow().len(), 3);
    rt.stop().await;
    assert!(
        rt.dispatch(Msg::Add {
            by: 1,
            shared: msg_token
        })
        .await
        .is_err()
    );
}
#[tokio::test(flavor = "current_thread")]
async fn retained_handles_preserve_original_identity_mixed_hook_order_and_panic_isolation() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                mixed_order(profile).await;
            }
        })
        .await;
}
async fn callback_identity(profile: Profile) {
    let rt = runtime(profile, Rc::new(Cell::new(0)));
    let count = Rc::new(Cell::new(0));
    let count_in = count.clone();
    type Retained = dyn Fn(&Arc<Msg>, &Arc<State>);
    let callback: Rc<Retained> = Rc::new(move |_, _| count_in.set(count_in.get() + 1));
    let old = rt.observe_retained_shared(callback.clone());
    let duplicate = rt.observe_retained_shared(callback.clone());
    let boot_calls = Rc::new(Cell::new(0));
    let calls = boot_calls.clone();
    type Boot = dyn Fn(&Arc<State>);
    let boot: Rc<Boot> = Rc::new(move |_| calls.set(calls.get() + 1));
    let off_boot = rt.on_boot_retained_shared(boot.clone());
    let off_duplicate = rt.on_boot_retained_shared(boot);
    rt.ready().await.unwrap();
    assert_eq!(boot_calls.get(), 1);
    rt.dispatch(Msg::Add {
        by: 1,
        shared: Rc::new(Cell::new(0)),
    })
    .await
    .unwrap();
    assert_eq!(count.get(), 1);
    old();
    rt.dispatch(Msg::Add {
        by: 1,
        shared: Rc::new(Cell::new(0)),
    })
    .await
    .unwrap();
    assert_eq!(count.get(), 1);
    let readded = rt.observe_retained_shared(callback.clone());
    rt.dispatch(Msg::Add {
        by: 1,
        shared: Rc::new(Cell::new(0)),
    })
    .await
    .unwrap();
    assert_eq!(count.get(), 2);
    duplicate();
    rt.dispatch(Msg::Add {
        by: 1,
        shared: Rc::new(Cell::new(0)),
    })
    .await
    .unwrap();
    assert_eq!(count.get(), 2);
    let again = rt.observe_retained_shared(callback);
    old();
    rt.dispatch(Msg::Add {
        by: 1,
        shared: Rc::new(Cell::new(0)),
    })
    .await
    .unwrap();
    assert_eq!(count.get(), 2);
    readded();
    again();
    off_boot();
    off_duplicate();
    rt.stop().await;
}
#[tokio::test(flavor = "current_thread")]
async fn original_callback_rc_deduplicates_and_stale_unsubscribe_deletes_a_reregistered_callback() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                callback_identity(profile).await;
            }
        })
        .await;
}

async fn live_membership(profile: Profile) {
    let rt = runtime(profile, Rc::new(Cell::new(0)));
    let log = Rc::new(RefCell::new(vec![]));
    let removed: Rc<RefCell<Option<demlik_tea::runtime::Unsubscribe>>> =
        Rc::new(RefCell::new(None));
    let added: Rc<RefCell<Option<demlik_tea::runtime::Unsubscribe>>> = Rc::new(RefCell::new(None));
    let flag = Rc::new(Cell::new(false));
    let (registry, output, remove, keep, once) = (
        rt.clone(),
        log.clone(),
        removed.clone(),
        added.clone(),
        flag.clone(),
    );
    let off_first = rt.observe(move |_, _| {
        output.borrow_mut().push("first");
        if !once.replace(true) {
            remove.borrow().as_ref().unwrap()();
            let output = output.clone();
            *keep.borrow_mut() =
                Some(registry.observe_retained(move |_, _| output.borrow_mut().push("added")));
        }
    });
    let output = log.clone();
    *removed.borrow_mut() =
        Some(rt.observe_retained(move |_, _| output.borrow_mut().push("removed")));
    let output = log.clone();
    let off_last = rt.observe(move |_, _| output.borrow_mut().push("last"));
    rt.ready().await.unwrap();
    for _ in 0..2 {
        rt.dispatch(Msg::Add {
            by: 1,
            shared: Rc::new(Cell::new(0)),
        })
        .await
        .unwrap();
    }
    assert_eq!(
        &*log.borrow(),
        &["first", "last", "added", "first", "last", "added"]
    );
    off_first();
    off_last();
    removed.borrow_mut().take().unwrap()();
    added.borrow_mut().take().unwrap()();
    rt.stop().await;
}
#[tokio::test(flavor = "current_thread")]
async fn borrowed_and_retained_callbacks_share_live_set_iteration_under_delete_and_insert() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                live_membership(profile).await;
            }
        })
        .await;
}
