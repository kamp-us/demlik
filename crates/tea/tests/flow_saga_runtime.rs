use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::flow::saga::{self, Saga, SagaConfig, SagaPhase, SagaState, SagaStep};
use demlik_tea::runtime::{
    self, CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Persistence, Profile,
};
use demlik_tea::storage::{MemoryStore, MemoryStoreError, Store, memory_store};
use demlik_tea::{Machine, Step, Sub, Tagged, Update, messages};
use std::{cell::RefCell, convert::Infallible, rc::Rc};
struct Forward {
    label: &'static str,
    _local: Rc<()>,
}
struct Undo {
    label: &'static str,
    _local: Rc<()>,
}
struct Fault(&'static str);
messages! {enum Msg{Start,ForwardOk,ForwardErr{error:Rc<Fault>},UndoOk,UndoErr{error:Rc<Fault>}}}
enum Cmd {
    Forward(Rc<Forward>),
    Undo(Rc<Undo>),
}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match self {
            Self::Forward(_) => "forward",
            Self::Undo(_) => "undo",
        }
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, messages: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        Ok(messages)
    }
}
#[derive(Clone)]
struct Model(Rc<SagaState<saga::StepId, Fault>>);
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
fn machine() -> Machine<'static, Model, Msg, Cmd, Sub> {
    let step = |label, undo| {
        SagaStep::new(
            Rc::new(Forward {
                label,
                _local: Rc::new(()),
            }),
            Rc::new(Undo {
                label: undo,
                _local: Rc::new(()),
            }),
        )
    };
    let saga: Rc<Saga<Forward, Undo, Fault>> = Rc::new(saga::create_saga(SagaConfig {
        steps: vec![step("reserve", "release"), step("charge", "refund")],
    }));
    let init = Rc::clone(&saga);
    Machine {
        init: Box::new(move |loaded, _| {
            Step::new(loaded.unwrap_or_else(|| Model(init.init())), vec![])
        }),
        update: Update::reducer(move |model: &Model, message: &Msg| match message {
            Msg::Start => saga.start(&model.0).map(Model, Cmd::Forward),
            Msg::ForwardOk => saga.step_ok(&model.0).map(Model, Cmd::Forward),
            Msg::ForwardErr { error } => saga
                .step_err(&model.0, Rc::clone(error))
                .map(Model, Cmd::Undo),
            Msg::UndoOk => saga.undo_ok(&model.0).map(Model, Cmd::Undo),
            Msg::UndoErr { error } => saga
                .undo_err(&model.0, Rc::clone(error))
                .map(Model, Cmd::Undo),
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    }
}
struct Host {
    store: MemoryStore<Model>,
    delivered: Rc<RefCell<Vec<&'static str>>>,
    inverse_error: Option<Rc<Fault>>,
}
impl Interpreter<Cmd> for Host {
    type Error = Infallible;
    fn interpret<'a>(
        &'a self,
        command: &'a Cmd,
        _: CommandContext<Msg, Infallible>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Infallible>> {
        Some(CommandWork::new(async move {
            let saved = self.store.load().await.unwrap().unwrap();
            match command {
                Cmd::Forward(command) => {
                    assert_eq!(saved.0.phase, SagaPhase::Running);
                    self.delivered.borrow_mut().push(command.label);
                    Ok(vec![])
                }
                Cmd::Undo(command) => {
                    assert_eq!(saved.0.phase, SagaPhase::Compensating);
                    assert_eq!(saved.0.done.len(), 1);
                    self.delivered.borrow_mut().push(command.label);
                    Ok(vec![self.inverse_error.as_ref().map_or(
                        Msg::UndoOk,
                        |error| Msg::UndoErr {
                            error: Rc::clone(error),
                        },
                    )])
                }
            }
        }))
    }
}
#[tokio::test(flavor = "current_thread")]
async fn a_persisted_saga_accepts_the_inflight_business_result_then_drains_its_inverse() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                for fail_inverse in [false, true] {
                    let store = memory_store(None);
                    let delivered = Rc::new(RefCell::new(vec![]));
                    let inverse = Rc::new(Fault("release unavailable"));
                    let options = || {
                        let mut options: Options<Model, Msg, MemoryStoreError, Infallible> =
                            Options::new(profile);
                        options.store = Some(Persistence::new(store.clone()));
                        options.terminal = Some(Rc::new(|model| saga::is_settled(&model.0)));
                        options
                    };
                    let host = || Host {
                        store: store.clone(),
                        delivered: Rc::clone(&delivered),
                        inverse_error: fail_inverse.then(|| Rc::clone(&inverse)),
                    };
                    let first =
                        runtime::launch(machine(), (), host(), NoSubscriptions::new(), options());
                    first.ready().await.unwrap();
                    first.dispatch(Msg::Start).await.unwrap();
                    first.dispatch(Msg::ForwardOk).await.unwrap();
                    assert_eq!(first.get_state().unwrap().0.position.number(), Some(1.0));
                    first.stop().await;
                    let restored =
                        runtime::launch(machine(), (), host(), NoSubscriptions::new(), options());
                    restored.ready().await.unwrap();
                    restored.idle().await.unwrap();
                    assert_eq!(&*delivered.borrow(), &vec!["reserve", "charge"]);
                    let forward = Rc::new(Fault("charge unavailable"));
                    restored
                        .dispatch(Msg::ForwardErr {
                            error: Rc::clone(&forward),
                        })
                        .await
                        .unwrap();
                    let done = restored.done().await.unwrap();
                    assert!(Rc::ptr_eq(done.0.error.value().unwrap(), &forward));
                    assert_eq!(done.0.error.value().unwrap().0, "charge unavailable");
                    if fail_inverse {
                        assert_eq!(done.0.phase, SagaPhase::CompensationFailed);
                        assert_eq!(done.0.done.len(), 1);
                        assert!(Rc::ptr_eq(
                            done.0.compensation_error.value().unwrap(),
                            &inverse
                        ));
                    } else {
                        assert_eq!(done.0.phase, SagaPhase::Aborted);
                        assert!(done.0.done.is_empty());
                    }
                    let saved = store.load().await.unwrap().unwrap();
                    assert_eq!(saved.0.phase, done.0.phase);
                    assert_eq!(&*delivered.borrow(), &vec!["reserve", "charge", "release"]);
                    restored.stop().await;
                }
            }
        })
        .await;
}
