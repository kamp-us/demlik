use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::runtime::{
    EffectScope, NoInterpreter, Options, Profile, Runtime, ScopeExit, SubscriptionWork,
    Subscriptions, launch,
};
use demlik_tea::{Machine, Step, Sub, Tagged, Update, messages};
use std::{cell::RefCell, convert::Infallible, rc::Rc, time::Duration};
use tokio::sync::Notify;
messages! {enum Msg{Ping}}
struct State;
impl Tagged for State {
    fn tag(&self) -> &str {
        "state"
    }
}
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
type Log = Rc<RefCell<Vec<String>>>;
struct Source {
    label: &'static str,
    log: Log,
    hold: Option<Rc<Notify>>,
    fail: Option<Rc<Notify>>,
}
impl Subscriptions<Sub, Msg> for Source {
    type Error = Rc<str>;
    fn start(
        &self,
        _: Sub,
        _: demlik_tea::runtime::Producer<Msg>,
    ) -> Result<Option<SubscriptionWork<Rc<str>>>, Rc<str>> {
        let label = self.label;
        let log = Rc::clone(&self.log);
        let hold = self.hold.clone();
        let work = SubscriptionWork::new(move || async move {
            log.borrow_mut().push(format!("close:{label}:start"));
            if let Some(hold) = hold {
                hold.notified().await;
            }
            log.borrow_mut().push(format!("close:{label}:done"));
            Ok(())
        });
        Ok(Some(if let Some(fail) = self.fail.clone() {
            work.with_source(async move {
                fail.notified().await;
                Err(Rc::from("unmapped source cause"))
            })
        } else {
            work
        }))
    }
}
fn runtime(
    label: &'static str,
    log: Log,
    hold: Option<Rc<Notify>>,
    fail: Option<Rc<Notify>>,
    profile: Profile,
) -> Runtime<State, Msg, Infallible, Rc<str>> {
    let machine: Machine<'static, State, Msg, Cmd, Sub> = Machine {
        init: Box::new(|_, _| Step::new(State, vec![])),
        update: Update::reducer(|_: &State, _: &Msg| Step::new(State, vec![])),
        subscriptions: demlik_tea::core::subscriptions(|_: &State| {
            vec![Sub::new("source", serde_json::json!({})).unwrap()]
        }),
    };
    let options: Options<State, Msg, Infallible, Rc<str>> = Options::new(profile);
    launch(
        machine,
        (),
        NoInterpreter::<Rc<str>>::new(),
        Source {
            label,
            log,
            hold,
            fail,
        },
        options,
    )
}
#[tokio::test(flavor = "current_thread")]
async fn close_is_lifo_idempotent_and_awaits_every_explicit_runtime_finalizer() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let scope = EffectScope::new();
            let log = Rc::new(RefCell::new(vec![]));
            let release = Rc::new(Notify::new());
            let first = runtime("first", Rc::clone(&log), None, None, Profile::Effect);
            let second = runtime(
                "second",
                Rc::clone(&log),
                Some(Rc::clone(&release)),
                None,
                Profile::Effect,
            );
            first.ready().await.unwrap();
            second.ready().await.unwrap();
            scope.attach(&first).await.unwrap();
            scope.attach(&second).await.unwrap();
            let mut closing = Box::pin(scope.close());
            assert!(futures::poll!(closing.as_mut()).is_pending());
            for _ in 0..8 {
                tokio::task::yield_now().await;
            }
            assert_eq!(&*log.borrow(), &["close:second:start"]);
            assert!(!scope.is_closed());
            release.notify_one();
            closing.await;
            scope.close().await;
            assert!(scope.is_closed());
            assert_eq!(
                &*log.borrow(),
                &[
                    "close:second:start",
                    "close:second:done",
                    "close:first:start",
                    "close:first:done"
                ]
            );
            let third = runtime("late", Rc::clone(&log), None, None, Profile::Effect);
            third.ready().await.unwrap();
            scope.attach(&third).await.unwrap();
            assert!(matches!(third.gate(), demlik_tea::runtime::Gate::Closed));
        })
        .await;
}
#[tokio::test(flavor = "current_thread")]
async fn source_failure_closes_siblings_retains_typed_cause_and_waits_for_held_cleanup() {
    tokio::task::LocalSet::new().run_until(async{
let scope=EffectScope::new();let log=Rc::new(RefCell::new(vec![]));let release=Rc::new(Notify::new());let fail=Rc::new(Notify::new());let sibling=runtime("sibling",Rc::clone(&log),Some(Rc::clone(&release)),None,Profile::Effect);let failing=runtime("failed",Rc::clone(&log),None,Some(Rc::clone(&fail)),Profile::Effect);sibling.ready().await.unwrap();failing.ready().await.unwrap();scope.attach(&sibling).await.unwrap();scope.attach(&failing).await.unwrap();fail.notify_one();for _ in 0..16{tokio::task::yield_now().await;}assert!(!scope.is_closed());let cause=scope.failure().unwrap();let error=cause.downcast_ref::<demlik_tea::runtime::RuntimeError<Infallible,Rc<str>>>().unwrap();assert!(matches!(error,demlik_tea::runtime::RuntimeError::Handler(error) if &**error=="unmapped source cause"));assert!(log.borrow().contains(&"close:sibling:start".to_owned()));release.notify_one();scope.close().await;assert!(scope.is_closed());
}).await;
}
#[tokio::test(flavor = "current_thread")]
async fn owned_scope_task_closes_after_success_defect_and_dropped_waiter_without_async_drop_claims()
{
    tokio::task::LocalSet::new()
        .run_until(async {
            let log = Rc::new(RefCell::new(vec![]));
            let scope = EffectScope::new();
            let run = runtime("normal", Rc::clone(&log), None, None, Profile::Effect);
            run.ready().await.unwrap();
            scope.attach(&run).await.unwrap();
            assert!(matches!(
                scope.run(async { Ok::<_, Infallible>(7) }).await,
                ScopeExit::Success(7)
            ));
            assert!(scope.is_closed());
            let scope = EffectScope::new();
            let result = scope
                .run(async {
                    panic!("host defect");
                    #[allow(unreachable_code)]
                    Ok::<(), Infallible>(())
                })
                .await;
            assert!(matches!(result,ScopeExit::Defect(cause) if cause.summary=="host defect"));
            assert!(scope.is_closed());
            let scope = EffectScope::new();
            let release = Rc::new(Notify::new());
            let run = runtime(
                "dropped",
                Rc::clone(&log),
                Some(Rc::clone(&release)),
                None,
                Profile::Effect,
            );
            run.ready().await.unwrap();
            scope.attach(&run).await.unwrap();
            let task = scope.spawn(futures::future::pending::<Result<(), Infallible>>());
            drop(task);
            for _ in 0..12 {
                tokio::task::yield_now().await;
            }
            assert!(log.borrow().contains(&"close:dropped:start".to_owned()));
            assert!(!scope.is_closed());
            release.notify_one();
            tokio::time::timeout(Duration::from_secs(1), scope.close())
                .await
                .unwrap();
            assert!(scope.is_closed());
            let scope = EffectScope::new();
            let stopped = runtime("explicit", Rc::clone(&log), None, None, Profile::Effect);
            stopped.ready().await.unwrap();
            scope.attach(&stopped).await.unwrap();
            stopped.stop().await;
            assert!(!scope.is_closing());
            scope.close().await;
            let promise = runtime("promise", log, None, None, Profile::Promise);
            promise.ready().await.unwrap();
            assert!(EffectScope::new().attach(&promise).await.is_err());
            promise.stop().await;
        })
        .await;
}
