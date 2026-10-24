use std::cell::{Cell, RefCell};
use std::convert::Infallible;
use std::rc::Rc;
use std::sync::Arc;

use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::data::{JsText, PlainData};
use demlik_tea::runtime::{
    ErrorPhase, NoInterpreter, NoSubscriptions, Options, Profile, RuntimeError, Supervision, launch,
};
use demlik_tea::{Machine, Step, Sub, Tagged, Update, messages};

struct Model {
    key: Arc<PlainData>,
    hits: u32,
    local: Rc<()>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
messages! {enum Msg {Addressed{key:PlainData},Ping,Crash}}
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
fn machine(key: PlainData) -> Machine<'static, Model, Msg, Cmd, Sub, ()> {
    Machine {
        init: Box::new(move |loaded, _| {
            Step::new(
                loaded.unwrap_or(Model {
                    key: Arc::new(key.clone()),
                    hits: 0,
                    local: Rc::new(()),
                }),
                vec![],
            )
        }),
        update: Update::reducer(|state: &Model, _: &Msg| {
            Step::new(
                Model {
                    key: Arc::clone(&state.key),
                    hits: state.hits + 1,
                    local: Rc::clone(&state.local),
                },
                vec![],
            )
        }),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    }
}
fn key(value: f64, reverse: bool) -> PlainData {
    let mut entries = vec![
        (JsText::from("number"), PlainData::Number(value)),
        (
            JsText::from_units(vec![0xd800]),
            PlainData::String(JsText::from_units(vec![0xdc00])),
        ),
    ];
    if reverse {
        entries.reverse();
    }
    PlainData::Object(entries.into_iter().collect())
}
#[tokio::test(flavor = "current_thread")]
async fn authored_identity_uses_plain_structural_values_and_a_foreign_drop_has_no_transition_notifications()
 {
    use demlik_tea::core::Identity;
    tokio::task::LocalSet::new().run_until(async {
        for profile in [Profile::Promise,Profile::Effect]{
            let state_calls=Rc::new(Cell::new(0));let projected=Rc::clone(&state_calls);
            let authored=machine(key(-0.0,false)).with_identity(Identity::new(move |state:&Model|{projected.set(projected.get()+1);(*state.key).clone()},|msg:&Msg|match msg{Msg::Addressed{key}=>key.clone(),_=>PlainData::Undefined}));
            let options:Options<Model,Msg,Infallible,Infallible>=Options::new(profile);
            let runtime=launch(authored,(),NoInterpreter::new(),NoSubscriptions::new(),options);
            runtime.ready().await.unwrap();
            let observations=Rc::new(RefCell::new(vec![]));let observed=Rc::clone(&observations);
            let _observe=runtime.observe(move |msg,_|observed.borrow_mut().push(msg.tag().to_owned()));
            runtime.dispatch(Msg::Addressed{key:key(0.0,true)}).await.unwrap();
            runtime.dispatch(Msg::Addressed{key:key(9.0,true)}).await.unwrap();
            let before=state_calls.get();runtime.dispatch(Msg::Ping).await.unwrap();assert_eq!(state_calls.get(),before,"an identity-free message never calls ofState");
            assert_eq!(runtime.get_state().unwrap().hits,2);assert_eq!(&*observations.borrow(),&["Addressed","Ping"]);
            let reports=runtime.reports();assert_eq!(reports.len(),1);assert_eq!(reports[0].phase,ErrorPhase::IdentityDrop);
            assert!(matches!(&*reports[0].error,RuntimeError::IdentityDrop(notice) if notice.msg_type=="Addressed"));
            assert_eq!(reports[0].error.name(),"IdentityDropNotice");
            let RuntimeError::IdentityDrop(notice)=&*reports[0].error else{unreachable!()};
            let data=serde_json::to_value(notice).unwrap();
            assert_eq!(data["name"],"IdentityDropNotice");assert_eq!(data["_tag"],"IdentityDropNotice");assert_eq!(data["msgType"],"Addressed");
            assert!(data["message"].as_str().unwrap().contains("dropped before `update` ran"));
            runtime.stop().await;
        }
    }).await;
}
#[tokio::test(flavor = "current_thread")]
async fn identity_projection_panics_are_supervised_before_the_reducer_runs() {
    use demlik_tea::core::Identity;
    tokio::task::LocalSet::new().run_until(async {
        let authored=machine(PlainData::Undefined).with_identity(Identity::new(|_:&Model|PlainData::Undefined,|_:&Msg|panic!("projection failed")));
        let mut options:Options<Model,Msg,Infallible,Infallible>=Options::new(Profile::Promise);
        options.supervision=Supervision::Restart(Rc::new(|state:&Model,_,_|Model{key:Arc::clone(&state.key),hits:10,local:Rc::clone(&state.local)}));
        let runtime=launch(authored,(),NoInterpreter::new(),NoSubscriptions::new(),options);runtime.ready().await.unwrap();
        runtime.dispatch(Msg::Crash).await.unwrap();assert_eq!(runtime.get_state().unwrap().hits,10);
        let reports=runtime.reports();assert_eq!(reports[0].phase,ErrorPhase::Reduce);assert!(matches!(&*reports[0].error,RuntimeError::Panic(cause) if cause.summary=="projection failed"));runtime.stop().await;
    }).await;
}

#[tokio::test(flavor = "current_thread")]
async fn typed_port_handles_share_reference_identity_but_listener_sets_are_per_runtime_and_live() {
    use demlik_tea::ports::{Port, define_port};
    tokio::task::LocalSet::new()
        .run_until(async {
            let port: Port<Cell<u32>> = define_port("runtime-hooks.live-port").unwrap();
            assert!(define_port::<String>("runtime-hooks.live-port").is_err());
            let options: Options<Model, Msg, Infallible, Infallible> =
                Options::new(Profile::Promise);
            let first = launch(
                machine(PlainData::Undefined),
                (),
                NoInterpreter::new(),
                NoSubscriptions::new(),
                options,
            );
            let options: Options<Model, Msg, Infallible, Infallible> =
                Options::new(Profile::Promise);
            let second = launch(
                machine(PlainData::Undefined),
                (),
                NoInterpreter::new(),
                NoSubscriptions::new(),
                options,
            );
            first.ready().await.unwrap();
            second.ready().await.unwrap();
            type Unsub = Rc<RefCell<Option<Box<dyn FnOnce()>>>>;
            let log = Rc::new(RefCell::new(vec![]));
            let own: Unsub = Rc::new(RefCell::new(None));
            let removed: Unsub = Rc::new(RefCell::new(None));
            let own_in = Rc::clone(&own);
            let removed_in = Rc::clone(&removed);
            let observed = Rc::clone(&log);
            let runtime = first.clone();
            let copied_port = port.clone();
            *own.borrow_mut() = Some(first.subscribe_port(
                &port,
                Rc::new(move |value: &Cell<u32>| {
                    observed.borrow_mut().push(format!("first:{}", value.get()));
                    value.set(2);
                    own_in.borrow_mut().take().unwrap()();
                    removed_in.borrow_mut().take().unwrap()();
                    let observed = Rc::clone(&observed);
                    let _keep = runtime.subscribe_port(
                        &copied_port,
                        Rc::new(move |value: &Cell<u32>| {
                            observed.borrow_mut().push(format!("added:{}", value.get()))
                        }),
                    );
                }),
            ));
            let observed = Rc::clone(&log);
            *removed.borrow_mut() = Some(first.subscribe_port(
                &port,
                Rc::new(move |_: &Cell<u32>| observed.borrow_mut().push("removed".into())),
            ));
            let observed = Rc::clone(&log);
            type CellListener = Rc<dyn Fn(&Cell<u32>)>;
            let shared: CellListener = Rc::new(move |value| {
                observed
                    .borrow_mut()
                    .push(format!("shared:{}", value.get()));
                value.set(3);
            });
            let unsubscribe = first.subscribe_port(&port, Rc::clone(&shared));
            let _same = first.subscribe_port(&port, shared);
            let _bad = first.subscribe_port(
                &port,
                Rc::new(|_: &Cell<u32>| panic!("port listener failed")),
            );
            let separate = Rc::new(Cell::new(0));
            let other = Rc::clone(&separate);
            let _other = second.subscribe_port(
                &port,
                Rc::new(move |_: &Cell<u32>| other.set(other.get() + 1)),
            );
            first.emit_port(&port.clone(), Cell::new(1));
            assert_eq!(&*log.borrow(), &["first:1", "shared:2", "added:3"]);
            assert_eq!(separate.get(), 0);
            assert_eq!(first.reports()[0].phase, ErrorPhase::PortEmit);
            unsubscribe();
            log.borrow_mut().clear();
            first.emit_port(&port, Cell::new(9));
            assert_eq!(&*log.borrow(), &["added:9"]);
            second.emit_port(&port, Cell::new(4));
            assert_eq!(separate.get(), 1);
            first.stop().await;
            second.stop().await;
        })
        .await;
}

struct Event {
    kind: &'static str,
    hits: u32,
}
impl Tagged for Event {
    fn tag(&self) -> &str {
        self.kind
    }
}
#[tokio::test(flavor = "current_thread")]
async fn semantic_events_and_telemetry_follow_public_notification_order_and_keep_failures_isolated()
{
    use demlik_tea::runtime::Telemetry;
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let log = Rc::new(RefCell::new(Vec::<String>::new()));
                let projections = Rc::new(Cell::new(0));
                let counted = Rc::clone(&projections);
                let options: Options<Model, Msg, Infallible, &'static str> = Options::new(profile);
                let mut options = options.with_events(move |msg: &Msg, state: &Model| {
                    counted.set(counted.get() + 1);
                    if matches!(msg, Msg::Crash) {
                        panic!("event projector failed");
                    }
                    vec![Event {
                        kind: "public_changed",
                        hits: state.hits,
                    }]
                });
                options.clock = Rc::new(|| 17.25);
                options.terminal = Some(Rc::new(|state: &Model| state.hits >= 2));
                let release = Rc::new(tokio::sync::Notify::new());
                let finished = Rc::new(tokio::sync::Notify::new());
                let published = Rc::clone(&log);
                let held = Rc::clone(&release);
                let completed = Rc::clone(&finished);
                options.telemetry = Some(Telemetry::new(move |event| {
                    let log = Rc::clone(&published);
                    let release = Rc::clone(&held);
                    let finished = Rc::clone(&completed);
                    async move {
                        log.borrow_mut().push(format!(
                            "telemetry:{}:{}:{}",
                            event.seq, event.msg_type, event.at
                        ));
                        if event.seq == 1.0 {
                            release.notified().await;
                            finished.notify_one();
                            return Err("telemetry rejected");
                        }
                        Ok(())
                    }
                }));
                let hooked = Rc::clone(&log);
                options.on_commit.push(Rc::new(move |msg: Option<&Msg>, _| {
                    if msg.is_some() {
                        hooked.borrow_mut().push("commit-hook".into());
                    }
                }));
                let runtime = launch(
                    machine(PlainData::Undefined),
                    (),
                    NoInterpreter::new(),
                    NoSubscriptions::new(),
                    options,
                );
                runtime.ready().await.unwrap();
                assert!(log.borrow().is_empty());
                runtime.dispatch(Msg::Ping).await.unwrap();
                assert_eq!(
                    projections.get(),
                    0,
                    "the event projector is lazy until a handler exists"
                );
                log.borrow_mut().clear();
                let observed = Rc::clone(&log);
                let _listener =
                    runtime.subscribe(move || observed.borrow_mut().push("listener".into()));
                let observed = Rc::clone(&log);
                let _observer =
                    runtime.observe(move |_, _| observed.borrow_mut().push("observer".into()));
                let bad = runtime.on(
                    "public_changed",
                    Rc::new(|_: &Event| panic!("event listener failed")),
                );
                let observed = Rc::clone(&log);
                let shared: Rc<dyn Fn(&Event)> = Rc::new(move |event| {
                    observed.borrow_mut().push(format!("event:{}", event.hits))
                });
                let off = runtime.on("public_changed", Rc::clone(&shared));
                let same = runtime.on("public_changed", shared);
                let done = runtime.done();
                let mut done = std::pin::pin!(done);
                assert!(futures::poll!(done.as_mut()).is_pending());
                runtime.dispatch(Msg::Ping).await.unwrap();
                assert_eq!(done.await.unwrap().hits, 2);
                assert_eq!(
                    &*log.borrow(),
                    &[
                        "listener",
                        "observer",
                        "commit-hook",
                        "event:2",
                        "telemetry:2:Ping:17.25"
                    ]
                );
                assert_eq!(projections.get(), 1);
                assert_eq!(runtime.reports()[0].phase, ErrorPhase::Event);
                bad();
                off();
                same();
                runtime.dispatch(Msg::Crash).await.unwrap();
                assert_eq!(
                    projections.get(),
                    1,
                    "removing all shared handlers disables projection again"
                );
                let _other = runtime.on("another_kind", Rc::new(|_: &Event| {}));
                runtime.dispatch(Msg::Crash).await.unwrap();
                assert_eq!(projections.get(), 2);
                assert_eq!(
                    runtime
                        .reports()
                        .iter()
                        .filter(|report| report.phase == ErrorPhase::Event)
                        .count(),
                    2
                );
                runtime.stop().await;
                release.notify_one();
                finished.notified().await;
                tokio::task::yield_now().await;
                assert!(
                    runtime
                        .reports()
                        .iter()
                        .any(|report| report.phase == ErrorPhase::Observer
                            && matches!(
                                &*report.error,
                                RuntimeError::Handler("telemetry rejected")
                            ))
                );
            }
        })
        .await;
}
#[tokio::test(flavor = "current_thread")]
async fn default_clock_telemetry_uses_integer_unix_milliseconds_inside_the_observed_host_range() {
    use demlik_tea::runtime::Telemetry;
    tokio::task::LocalSet::new()
        .run_until(async {
            let events = Rc::new(RefCell::new(vec![]));
            let published = Rc::clone(&events);
            let mut options: Options<Model, Msg, Infallible, Infallible> =
                Options::new(Profile::Promise);
            options.telemetry = Some(Telemetry::sync(move |event| {
                published.borrow_mut().push(event);
                Ok(())
            }));
            let runtime = launch(
                machine(PlainData::Undefined),
                (),
                NoInterpreter::new(),
                NoSubscriptions::new(),
                options,
            );
            runtime.ready().await.unwrap();
            let before = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as f64;
            for _ in 0..32 {
                runtime.dispatch(Msg::Ping).await.unwrap();
            }
            let after = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as f64;
            {
                let events = events.borrow();
                assert_eq!(events.len(), 32);
                for (index, event) in events.iter().enumerate() {
                    assert_eq!(
                        event.at.fract(),
                        0.0,
                        "Date.now's default clock floors fractional milliseconds"
                    );
                    assert!(before <= event.at && event.at <= after);
                    assert_eq!(event.seq, (index + 1) as f64);
                }
            }
            runtime.stop().await;
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn replacing_the_last_port_listener_uses_a_new_bucket_after_the_current_emission() {
    use demlik_tea::ports::define_port;
    tokio::task::LocalSet::new()
        .run_until(async {
            let port = define_port::<()>("runtime-hooks.last-port-listener").unwrap();
            let options: Options<Model, Msg, Infallible, Infallible> =
                Options::new(Profile::Promise);
            let runtime = launch(
                machine(PlainData::Undefined),
                (),
                NoInterpreter::new(),
                NoSubscriptions::new(),
                options,
            );
            runtime.ready().await.unwrap();
            type Unsub = Rc<RefCell<Option<Box<dyn FnOnce()>>>>;
            let own: Unsub = Rc::new(RefCell::new(None));
            let owned = Rc::clone(&own);
            let log = Rc::new(RefCell::new(vec![]));
            let recorded = Rc::clone(&log);
            let current = runtime.clone();
            let same = port.clone();
            *own.borrow_mut() = Some(runtime.subscribe_port(
                &port,
                Rc::new(move |_: &()| {
                    recorded.borrow_mut().push("first");
                    owned.borrow_mut().take().unwrap()();
                    let recorded = Rc::clone(&recorded);
                    let _keep = current.subscribe_port(
                        &same,
                        Rc::new(move |_: &()| recorded.borrow_mut().push("replacement")),
                    );
                }),
            ));
            runtime.emit_port(&port, ());
            assert_eq!(&*log.borrow(), &["first"]);
            runtime.emit_port(&port, ());
            assert_eq!(&*log.borrow(), &["first", "replacement"]);
            runtime.stop().await;
        })
        .await;
}

struct Emit;
impl Tagged for Emit {
    fn tag(&self) -> &str {
        "emit"
    }
}
impl CommandFamily for Emit {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, messages: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        Ok(messages)
    }
}
struct PortHandler(demlik_tea::ports::Port<Cell<u32>>);
impl demlik_tea::runtime::Interpreter<Emit> for PortHandler {
    type Error = Infallible;
    fn interpret<'a>(
        &'a self,
        _: &'a Emit,
        context: demlik_tea::runtime::CommandContext<Msg, Self::Error>,
    ) -> Option<demlik_tea::runtime::CommandWork<'a, Vec<Msg>, Self::Error>> {
        Some(demlik_tea::runtime::CommandWork::new(async move {
            context.emit(&self.0, Cell::new(5));
            Ok(vec![])
        }))
    }
}
#[tokio::test(flavor = "current_thread")]
async fn a_handler_emits_typed_nonserializable_port_data_before_public_commit() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let port = demlik_tea::ports::define_port("runtime-hooks.handler-port").unwrap();
            let log = Rc::new(RefCell::new(vec![]));
            let Machine {
                init,
                update,
                subscriptions,
            } = machine(PlainData::Undefined);
            let machine = Machine {
                init: Box::new(move |state, input| {
                    init(state, input).map(|state| state, |cmd: Cmd| match cmd {})
                }),
                update: Update::reducer(move |state: &Model, msg: &Msg| {
                    let next = update.apply(state, msg).unwrap();
                    Step::new(next.state, vec![Emit])
                }),
                subscriptions,
            };
            let committed = Rc::clone(&log);
            let mut options: Options<Model, Msg, Infallible, Infallible> =
                Options::new(Profile::Promise);
            options.on_commit.push(Rc::new(move |msg: Option<&Msg>, _| {
                if msg.is_some() {
                    committed.borrow_mut().push("commit".into());
                }
            }));
            let runtime = launch(
                machine,
                (),
                PortHandler(port.clone()),
                NoSubscriptions::new(),
                options,
            );
            runtime.ready().await.unwrap();
            let received = Rc::clone(&log);
            let _listen = runtime.subscribe_port(
                &port,
                Rc::new(move |value: &Cell<u32>| {
                    received.borrow_mut().push(format!("port:{}", value.get()))
                }),
            );
            runtime.dispatch(Msg::Ping).await.unwrap();
            assert_eq!(&*log.borrow(), &["port:5", "commit"]);
            runtime.stop().await;
        })
        .await;
}
