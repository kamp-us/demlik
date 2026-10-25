use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::flow::poller::{
    Poller, PollerConfig, PollerKnob, PollerPhase, PollerState, create_poller,
};
use demlik_tea::resilience::deadline::{self, DeadlineExceeded, DeadlinesSub};
use demlik_tea::runtime::{
    self, CommandContext, CommandWork, Interpreter, Options, Producer, Profile, SubscriptionWork,
    Subscriptions,
};
use demlik_tea::timing::{Timer, TimerCallback, TimerError};
use demlik_tea::{Machine, Step, Tagged, Update, messages};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    convert::Infallible,
    rc::Rc,
};
struct Reading {
    ready: bool,
    _local: Rc<()>,
}
struct Fetch {
    _local: Rc<()>,
}
struct Fault;
messages! {enum Msg{Begin{at:f64},Deadline{msg:DeadlineExceeded},Read{value:Rc<Reading>,at:f64}}}
struct Cmd(Rc<Fetch>);
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        "fetch_status"
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Vec<Msg>;
    fn settle(self, messages: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        Ok(messages)
    }
}
struct Model {
    poll: Rc<PollerState<Reading, Fault>>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
#[derive(Default)]
struct Clock {
    now: Cell<f64>,
    next: Cell<u64>,
    pending: RefCell<BTreeMap<u64, (f64, TimerCallback)>>,
    arms: RefCell<Vec<f64>>,
    clears: Cell<usize>,
}
impl Clock {
    fn advance_to(&self, at: f64) {
        self.now.set(at);
        loop {
            let next = self
                .pending
                .borrow()
                .iter()
                .find(|(_, value)| value.0 <= at)
                .map(|(id, _)| *id);
            let Some(id) = next else { return };
            let (_, callback) = self.pending.borrow_mut().remove(&id).unwrap();
            callback().unwrap();
        }
    }
}
impl Timer for Clock {
    type Handle = u64;
    fn now_ms(&self) -> f64 {
        self.now.get()
    }
    fn set_timeout(&self, ms: f64, callback: TimerCallback) -> Result<u64, TimerError> {
        let id = self.next.get();
        self.next.set(id + 1);
        self.arms.borrow_mut().push(ms);
        self.pending
            .borrow_mut()
            .insert(id, (self.now.get() + ms, callback));
        Ok(id)
    }
    fn clear_timeout(&self, id: &u64) {
        self.clears.set(self.clears.get() + 1);
        self.pending.borrow_mut().remove(id);
    }
}
struct Runner(Rc<Clock>);
impl Subscriptions<DeadlinesSub, Msg> for Runner {
    type Error = TimerError;
    fn has_runner(&self, kind: &str) -> bool {
        kind == "deadline"
    }
    fn start(
        &self,
        sub: DeadlinesSub,
        producer: Producer<Msg>,
    ) -> Result<Option<SubscriptionWork<TimerError>>, TimerError> {
        let active = deadline::subscribe_deadline(
            &sub,
            Rc::clone(&self.0),
            Rc::new(move |msg| {
                let _ = producer.emit(Msg::Deadline { msg });
            }),
        )?;
        Ok(Some(SubscriptionWork::new(move || {
            let result = active.cancel();
            async move { result }
        })))
    }
}
struct Host {
    clock: Rc<Clock>,
    reads: Rc<Cell<u32>>,
}
impl Interpreter<Cmd> for Host {
    type Error = TimerError;
    fn interpret<'a>(
        &'a self,
        command: &'a Cmd,
        _: CommandContext<Msg, TimerError>,
    ) -> Option<CommandWork<'a, Vec<Msg>, TimerError>> {
        Some(CommandWork::new(async move {
            let _ = &command.0;
            let count = self.reads.get() + 1;
            self.reads.set(count);
            Ok(vec![Msg::Read {
                value: Rc::new(Reading {
                    ready: count >= 3,
                    _local: Rc::new(()),
                }),
                at: self.clock.now_ms(),
            }])
        }))
    }
}
fn machine() -> Machine<'static, Model, Msg, Cmd, DeadlinesSub> {
    let fetch = Rc::new(Fetch {
        _local: Rc::new(()),
    });
    let poll: PollerKnob<'static, Model, Reading, Fetch, Fault> = create_poller(PollerConfig::new(
        5.0,
        |state: &Model| {
            state
                .poll
                .last_result
                .value()
                .is_some_and(|value| value.ready)
        },
        move || Rc::clone(&fetch),
    ));
    let poll: Rc<dyn Poller<Reading, Fetch, Fault>> = Rc::new(poll);
    let init = Rc::clone(&poll);
    let update = Rc::clone(&poll);
    Machine {
        init: Box::new(move |_, _| Step::new(Model { poll: init.init() }, vec![])),
        update: Update::reducer(move |state: &Model, message: &Msg| {
            let step = match message {
                Msg::Begin { at } => update.start(&state.poll, *at),
                Msg::Deadline { msg } => {
                    let _ = &msg.id;
                    update.tick(&state.poll)
                }
                Msg::Read { value, at } => update
                    .tick_result(&state.poll, Rc::clone(value), *at, value.ready)
                    .unwrap(),
            };
            step.map(|poll| Model { poll }, Cmd)
        }),
        subscriptions: demlik_tea::core::subscriptions(move |state: &Model| {
            let deadlines = poll.subs(&state.poll);
            if deadlines.is_empty() {
                vec![]
            } else {
                vec![demlik_tea::Sub::new("deadline", deadlines).unwrap()]
            }
        }),
    }
}
#[tokio::test(flavor = "current_thread")]
async fn real_deadline_subscriptions_read_once_per_window_and_disarm_after_the_final_result() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let clock = Rc::new(Clock::default());
                let reads = Rc::new(Cell::new(0));
                let mut options: Options<Model, Msg, Infallible, TimerError> =
                    Options::new(profile);
                let now = Rc::clone(&clock);
                options.clock = Rc::new(move || now.now_ms());
                options.terminal = Some(Rc::new(|state| {
                    matches!(state.poll.phase, PollerPhase::Done)
                }));
                let runtime = runtime::launch(
                    machine(),
                    (),
                    Host {
                        clock: Rc::clone(&clock),
                        reads: Rc::clone(&reads),
                    },
                    Runner(Rc::clone(&clock)),
                    options,
                );
                runtime.ready().await.unwrap();
                runtime.dispatch(Msg::Begin { at: 0.0 }).await.unwrap();
                assert_eq!(reads.get(), 0);
                assert_eq!(&*clock.arms.borrow(), &vec![5.0]);
                for (at, count) in [(4.0, 0), (5.0, 1), (9.0, 1), (10.0, 2), (15.0, 3)] {
                    clock.advance_to(at);
                    runtime.idle().await.unwrap();
                    assert_eq!(reads.get(), count, "at {at}");
                }
                let done = runtime.done().await.unwrap();
                assert!(matches!(done.poll.phase, PollerPhase::Done));
                assert!(done.poll.last_result.value().unwrap().ready);
                assert!(clock.pending.borrow().is_empty());
                assert_eq!(&*clock.arms.borrow(), &vec![5.0, 5.0, 5.0]);
                clock.advance_to(1000.0);
                runtime.idle().await.unwrap();
                assert_eq!(reads.get(), 3);
                runtime.stop().await;
                assert_eq!(clock.clears.get(), 3);
            }
        })
        .await;
}
