#[path = "../../../verification/parity/authored-state-interface-types/canonical.rs"]
mod canonical;

use demlik_tea::{
    Machine, Step, TryUpdate, Update,
    core::{ApplyError, subscriptions, try_fold_updates},
    data::Sub,
    runtime::{self, NoInterpreter, NoSubscriptions, Options, Persistence, Profile},
    storage::{Migrated, Store},
};
use std::{
    borrow::Cow,
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
};

struct Opaque<'a> {
    label: &'a str,
    marker: &'a Cell<u8>,
}
struct BorrowedState<'a> {
    count: usize,
    owner: &'a Opaque<'a>,
}
demlik_tea::messages! { enum Input { Added, Rejected } }

#[test]
fn authored_apply_and_fold_keep_borrowed_opaque_state_commands_and_declared_cause() {
    let label = String::from("invoice");
    let marker = Cell::new(9);
    let owner = Opaque {
        label: &label,
        marker: &marker,
    };
    let cause = Rc::new(Opaque {
        label: &label,
        marker: &marker,
    });
    let update: TryUpdate<'_, BorrowedState<'_>, Input, &Opaque<'_>, Rc<Opaque<'_>>> =
        TryUpdate::try_reducer(|state: &BorrowedState<'_>, msg| match msg {
            Input::Added => Ok(Step::new(
                BorrowedState {
                    count: state.count + 1,
                    owner: state.owner,
                },
                vec![state.owner],
            )),
            Input::Rejected => Err(Rc::clone(&cause)),
        });
    let seed = BorrowedState {
        count: 0,
        owner: &owner,
    };
    assert_eq!(update.accepted_types(Some(&seed)), ["Added", "Rejected"]);
    assert!(update.accepted_types(None).is_empty());
    let Ok(applied) = update.try_apply(&seed, &Input::Added) else {
        panic!("authored state was refused")
    };
    assert_eq!(applied.state.count, 1);
    assert!(std::ptr::eq(applied.state.owner, &owner));
    assert!(std::ptr::eq(applied.commands[0], &owner));
    let Ok(folded) = try_fold_updates(&update, seed, [Input::Added, Input::Added]) else {
        panic!("fold required a state tag")
    };
    assert_eq!(folded.state.count, 2);
    assert_eq!(folded.commands.len(), 2);
    assert!(
        folded
            .commands
            .iter()
            .all(|value| std::ptr::eq(*value, &owner))
    );
    let Err(ApplyError::Reduce(error)) = update.try_apply(&folded.state, &Input::Rejected) else {
        panic!("original typed refusal changed")
    };
    assert!(Rc::ptr_eq(&error, &cause));
    assert_eq!(error.label, "invoice");
    assert!(std::ptr::eq(error.marker, &marker));
}

struct RetainedStore {
    state: Rc<canonical::State<'static>>,
    loads: Rc<Cell<usize>>,
    saves: Rc<RefCell<Vec<Rc<canonical::State<'static>>>>>,
}
impl Store<Rc<canonical::State<'static>>> for RetainedStore {
    type Raw = Option<Rc<canonical::State<'static>>>;
    type Error = Infallible;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        self.loads.set(self.loads.get() + 1);
        Ok(Some(Rc::clone(&self.state)))
    }
    async fn save(&self, state: &Rc<canonical::State<'static>>) -> Result<(), Self::Error> {
        self.saves.borrow_mut().push(Rc::clone(state));
        Ok(())
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<Rc<canonical::State<'static>>> {
        match raw {
            Some(state) => Migrated::State(state),
            None => Migrated::Fresh,
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn both_real_runtime_profiles_load_and_retain_the_canonical_rc_without_a_state_tag() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let original: Rc<canonical::State<'static>> =
                    canonical::canonical(Cow::Owned("owned invoice".into()));
                let loads = Rc::new(Cell::new(0));
                let saves = Rc::new(RefCell::new(Vec::new()));
                let init_calls = Rc::new(Cell::new(0));
                let loaded_owner = Rc::clone(&original);
                let init_count = Rc::clone(&init_calls);
                let machine: Machine<
                    'static,
                    Rc<canonical::State<'static>>,
                    canonical::Msg,
                    canonical::NoCommand,
                    Sub<()>,
                > = Machine {
                    init: Box::new(move |loaded, _| {
                        init_count.set(init_count.get() + 1);
                        let loaded = loaded.expect("real Store restored the canonical state");
                        assert!(Rc::ptr_eq(&loaded, &loaded_owner));
                        Step::new(loaded, vec![])
                    }),
                    update: Update::reducer(|state, _| Step::new(Rc::clone(state), vec![])),
                    subscriptions: subscriptions(|_| vec![]),
                };
                let mut options: Options<
                    Rc<canonical::State<'static>>,
                    canonical::Msg,
                    Infallible,
                    Infallible,
                > = Options::new(profile);
                options.store = Some(Persistence::new(RetainedStore {
                    state: Rc::clone(&original),
                    loads: Rc::clone(&loads),
                    saves: Rc::clone(&saves),
                }));
                let run = runtime::launch(
                    machine,
                    (),
                    NoInterpreter::new(),
                    NoSubscriptions::new(),
                    options,
                );
                assert!(run.ready().await.is_ok());
                assert!(Rc::ptr_eq(run.get_state().unwrap().as_ref(), &original));
                assert!(run.dispatch(canonical::Msg::Keep).await.is_ok());
                assert_eq!(loads.get(), 1);
                assert_eq!(init_calls.get(), 1);
                assert!(Rc::ptr_eq(run.get_state().unwrap().as_ref(), &original));
                assert_eq!(saves.borrow().len(), 2);
                assert!(
                    saves
                        .borrow()
                        .iter()
                        .all(|value| Rc::ptr_eq(value, &original))
                );
                run.stop().await;
            }
        })
        .await;
}
