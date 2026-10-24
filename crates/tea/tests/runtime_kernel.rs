use std::cell::RefCell;
use std::rc::Rc;

use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::runtime::{
    CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Persistence, Profile,
    launch,
};
use demlik_tea::storage::{Migrated, Store};
use demlik_tea::{Machine, Step, Sub, Tagged, Update, messages};

struct Model {
    n: u32,
    done: bool,
    local: Rc<()>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
messages! { #[derive(Debug)] enum Msg { Start, Added { by: u32 }, Finish } }
enum Cmd {
    Batch,
    Last,
}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match self {
            Self::Batch => "batch",
            Self::Last => "last",
        }
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, value: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        Ok(value)
    }
}
type Log = Rc<RefCell<Vec<String>>>;
#[derive(Clone)]
struct Saved {
    cell: Rc<RefCell<Option<(u32, bool)>>>,
    log: Log,
}
impl Store<Model> for Saved {
    type Raw = Option<(u32, bool)>;
    type Error = &'static str;
    async fn load(&self) -> Result<Self::Raw, Self::Error> {
        Ok(*self.cell.borrow())
    }
    async fn save(&self, state: &Model) -> Result<(), Self::Error> {
        self.log.borrow_mut().push(format!("save:{}", state.n));
        *self.cell.borrow_mut() = Some((state.n, state.done));
        Ok(())
    }
    fn migrate(&self, raw: Self::Raw) -> Migrated<Model> {
        match raw {
            None => Migrated::Fresh,
            Some((n, done)) => Migrated::State(Model {
                n,
                done,
                local: Rc::new(()),
            }),
        }
    }
}
struct Effects(Log);
impl Interpreter<Cmd> for Effects {
    type Error = &'static str;
    fn interpret<'a>(
        &'a self,
        command: &'a Cmd,
        context: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Self::Error>> {
        Some(CommandWork::new(async move {
            self.0.borrow_mut().push(command.tag().into());
            Ok(match command {
                Cmd::Batch => vec![Msg::Added { by: 2 }, Msg::Added { by: 4 }],
                Cmd::Last => {
                    context.dispatch(Msg::Added { by: 8 }).unwrap();
                    vec![Msg::Finish]
                }
            })
        }))
    }
}
fn machine() -> Machine<'static, Model, Msg, Cmd, Sub, ()> {
    Machine {
        init: Box::new(|loaded, _| {
            Step::new(
                loaded.unwrap_or(Model {
                    n: 0,
                    done: false,
                    local: Rc::new(()),
                }),
                vec![],
            )
        }),
        update: Update::reducer(|state: &Model, msg: &Msg| {
            let (n, done, commands) = match msg {
                Msg::Start => (1, false, vec![Cmd::Batch, Cmd::Last]),
                Msg::Added { by } => (state.n + by, state.done, vec![]),
                Msg::Finish => (state.n, true, vec![]),
            };
            Step::new(
                Model {
                    n,
                    done,
                    local: Rc::clone(&state.local),
                },
                commands,
            )
        }),
        subscriptions: Box::new(|_| vec![]),
    }
}
#[tokio::test(flavor = "current_thread")]
async fn real_store_commits_before_serial_handlers_and_transitive_followups() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let log = Rc::new(RefCell::new(vec![]));
            let store = Saved {
                cell: Rc::new(RefCell::new(None)),
                log: Rc::clone(&log),
            };
            let mut options = Options::new(Profile::Promise);
            options.store = Some(Persistence::new(store.clone()));
            options.terminal = Some(Rc::new(|state: &Model| state.done));
            let commits = Rc::clone(&log);
            options
                .on_commit
                .push(Rc::new(move |msg: Option<&Msg>, state: &Model| {
                    commits.borrow_mut().push(format!(
                        "commit:{}:{}",
                        msg.map(Tagged::tag).unwrap_or("boot"),
                        state.n
                    ));
                }));
            let runtime = launch(
                machine(),
                (),
                Effects(Rc::clone(&log)),
                NoSubscriptions::new(),
                options,
            );
            runtime.ready().await.unwrap();
            runtime.dispatch(Msg::Start).await.unwrap();
            assert_eq!(runtime.get_state().unwrap().n, 15);
            assert_eq!(store.load().await.unwrap(), Some((15, true)));
            assert_eq!(runtime.done().await.unwrap().n, 15);
            assert_eq!(
                &*log.borrow(),
                &[
                    "save:0",
                    "commit:boot:0",
                    "save:1",
                    "batch",
                    "last",
                    "commit:Start:1",
                    "save:3",
                    "commit:Added:3",
                    "save:7",
                    "commit:Added:7",
                    "save:15",
                    "commit:Added:15",
                    "save:15",
                    "commit:Finish:15",
                ]
            );
            fn send<T: Send>(_: T) {}
            send(runtime.producer());
            runtime.stop().await;
        })
        .await;
}

struct ScopedDefect(Log);
impl Interpreter<Cmd> for ScopedDefect {
    type Error = &'static str;
    fn interpret<'a>(
        &'a self,
        _: &'a Cmd,
        _: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Self::Error>> {
        Some(
            CommandWork::new(async { panic!("body defect") }).with_cleanup(|| async {
                tokio::task::yield_now().await;
                self.0.borrow_mut().push("released".into());
                Ok(())
            }),
        )
    }
}
#[tokio::test(flavor = "current_thread")]
async fn explicit_async_command_cleanup_runs_after_a_defect_before_dispatch_rejects() {
    tokio::task::LocalSet::new().run_until(async {
        let log=Rc::new(RefCell::new(vec![]));
        let mut options: Options<Model,Msg,std::convert::Infallible,&'static str>=Options::new(Profile::Effect);
        let commits=Rc::clone(&log);
        options.on_commit.push(Rc::new(move |msg,state|if msg.is_some() {commits.borrow_mut().push(format!("committed:{}",state.n));}));
        let runtime=launch(machine(),(),ScopedDefect(Rc::clone(&log)),NoSubscriptions::new(),options);
        runtime.ready().await.unwrap();
        let error=runtime.dispatch(Msg::Start).await.unwrap_err();
        assert!(matches!(&*error,demlik_tea::runtime::RuntimeError::Panic(cause) if cause.summary=="body defect"));
        assert_eq!(&*log.borrow(),&["released","committed:1"]);
        runtime.stop().await;
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn storeless_counter_has_an_eager_local_launch_and_a_sendable_remote_producer() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let log = Rc::new(RefCell::new(vec![]));
            let mut options: Options<Model, Msg, std::convert::Infallible, &'static str> =
                Options::new(Profile::Promise);
            options.terminal = Some(Rc::new(|state: &Model| state.n >= 5));
            let runtime = launch(machine(), (), Effects(log), NoSubscriptions::new(), options);
            assert_eq!(runtime.get_state().unwrap().n, 0);
            runtime.ready().await.unwrap();
            let producer = runtime.producer();
            std::thread::spawn(move || producer.emit(Msg::Added { by: 5 }))
                .join()
                .unwrap()
                .unwrap();
            runtime.idle().await.unwrap();
            assert_eq!(runtime.result().unwrap().n, 5);
            assert_eq!(runtime.done().await.unwrap().n, 5);
            runtime.stop().await;
        })
        .await;
}
