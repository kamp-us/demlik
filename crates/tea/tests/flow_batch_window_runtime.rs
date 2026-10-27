use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::data::EitherSub;
use demlik_tea::flow::batch_window::{self as batch, BatchWindow, BatchWindowConfig};
use demlik_tea::resilience::deadline::{DeadlineExceeded, DeadlinesSub};
use demlik_tea::runtime::{
    self, CommandContext, CommandWork, Interpreter, Options, Profile, RuntimeTimer,
    SubscriptionWork, Subscriptions,
};
use demlik_tea::timing::{Timer, TimerCallback, TimerError};
use demlik_tea::work_queue::{Queue, enqueue_op};
use demlik_tea::{Machine, Step, Sub, Tagged, TimerDeps, Update};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
};

struct Item {
    value: u32,
    _local: Rc<()>,
}
struct Flush(Rc<Vec<Rc<Item>>>);
impl Tagged for Flush {
    fn tag(&self) -> &str {
        "flush"
    }
}
impl CommandFamily for Flush {
    type Msg = DeadlineExceeded;
    type Completion = Vec<DeadlineExceeded>;
    fn settle(
        self,
        messages: Self::Completion,
        _: f64,
    ) -> Result<Vec<DeadlineExceeded>, CommandContractError> {
        Ok(messages)
    }
}
struct Model {
    batch: Rc<BatchWindow<Item>>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
type Declarations = EitherSub<Sub<TimerDeps<DeadlineExceeded>>, DeadlinesSub>;
#[derive(Default)]
struct Clock {
    delays: RefCell<Vec<f64>>,
    pending: RefCell<Option<TimerCallback>>,
    clears: Cell<u32>,
}
impl Timer for Clock {
    type Handle = ();
    fn now_ms(&self) -> f64 {
        1000.0
    }
    fn set_timeout(&self, ms: f64, callback: TimerCallback) -> Result<(), TimerError> {
        self.delays.borrow_mut().push(ms);
        *self.pending.borrow_mut() = Some(callback);
        Ok(())
    }
    fn clear_timeout(&self, _: &()) {
        self.clears.set(self.clears.get() + 1);
        self.pending.borrow_mut().take();
    }
}
struct DeadlineRunner(Rc<Clock>);
impl Subscriptions<Declarations, DeadlineExceeded> for DeadlineRunner {
    type Error = TimerError;
    fn has_runner(&self, kind: &str) -> bool {
        kind == "deadline"
    }
    fn start(
        &self,
        sub: Declarations,
        producer: runtime::Producer<DeadlineExceeded>,
    ) -> Result<Option<SubscriptionWork<TimerError>>, TimerError> {
        let EitherSub::Right(sub) = sub else {
            return Ok(None);
        };
        let subscription = batch::subscribe_batch_window(
            &sub,
            Rc::clone(&self.0),
            Rc::new(move |msg| producer.emit(msg).unwrap()),
        )?;
        Ok(Some(SubscriptionWork::new(move || async move {
            subscription.cancel()
        })))
    }
}
struct EnqueueBatch(Rc<RefCell<Queue<Vec<Rc<Item>>>>>);
impl Interpreter<Flush> for EnqueueBatch {
    type Error = TimerError;
    fn interpret<'a>(
        &'a self,
        command: &'a Flush,
        _: CommandContext<DeadlineExceeded, TimerError>,
    ) -> Option<CommandWork<'a, Vec<DeadlineExceeded>, TimerError>> {
        Some(CommandWork::new(async move {
            let enqueued = enqueue_op(&self.0.borrow(), Rc::clone(&command.0), 1100.0, "flushed");
            *self.0.borrow_mut() = enqueued.next;
            Ok(vec![])
        }))
    }
}
fn config() -> BatchWindowConfig<'static, Item, Flush> {
    BatchWindowConfig::new(10.0, 1000.0, |items| Flush(Rc::clone(items)))
}
fn machine(absolute: bool) -> Machine<'static, Model, DeadlineExceeded, Flush, Declarations> {
    let mut cells: demlik_tea::core::Row<'static, Model, DeadlineExceeded, Flush> =
        Default::default();
    cells.insert(
        "deadline_exceeded".into(),
        Box::new(|state, msg| {
            let step = batch::on_window(&config(), &state.batch, msg.at_ms.number_or_zero());
            Step::new(Model { batch: step.state }, step.commands)
        }),
    );
    Machine {
        init: Box::new(|_, _| {
            Step::new(
                Model {
                    batch: Rc::new(BatchWindow {
                        buffer: Rc::new(vec![
                            Rc::new(Item {
                                value: 8,
                                _local: Rc::new(()),
                            }),
                            Rc::new(Item {
                                value: 9,
                                _local: Rc::new(()),
                            }),
                        ]),
                        opened_at: Some(100.0),
                    }),
                },
                vec![],
            )
        }),
        update: Update::raw_reducer(cells),
        subscriptions: demlik_tea::core::subscriptions(move |state: &Model| {
            if absolute {
                let deadlines = batch::subs_for(&config(), &state.batch, None);
                if deadlines.is_empty() {
                    vec![]
                } else {
                    vec![EitherSub::Right(Sub::new("deadline", deadlines).unwrap())]
                }
            } else {
                batch::timer_for(&config(), &state.batch, None).map_or_else(Vec::new, |deps| {
                    vec![EitherSub::Left(Sub::new("timer", deps).unwrap())]
                })
            }
        }),
    }
}
#[tokio::test(flavor = "current_thread")]
async fn restored_windows_reuse_timer_owners_and_flush_one_ordered_queue_item_or_cancel_cleanly() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                for absolute in [false, true] {
                    for fire in [false, true] {
                        let clock = Rc::new(Clock::default());
                        let queue = Rc::new(RefCell::new(Queue::new()));
                        let mut options: Options<Model, DeadlineExceeded, Infallible, TimerError> =
                            Options::new(profile);
                        options.timer = Some(RuntimeTimer::new(Rc::clone(&clock)));
                        options.terminal =
                            Some(Rc::new(|state: &Model| state.batch.buffer.is_empty()));
                        let runtime = runtime::launch(
                            machine(absolute),
                            (),
                            EnqueueBatch(Rc::clone(&queue)),
                            DeadlineRunner(Rc::clone(&clock)),
                            options,
                        );
                        runtime.ready().await.unwrap();
                        assert_eq!(
                            &*clock.delays.borrow(),
                            &[if absolute { 100.0 } else { 1000.0 }]
                        );
                        assert!(queue.borrow().is_empty());
                        if fire {
                            let callback = clock.pending.borrow_mut().take().unwrap();
                            callback().unwrap();
                            assert!(runtime.done().await.unwrap().batch.buffer.is_empty());
                            runtime.idle().await.unwrap();
                            assert_eq!(queue.borrow().len(), 1);
                            assert_eq!(
                                queue
                                    .borrow()
                                    .get(0)
                                    .unwrap()
                                    .input
                                    .iter()
                                    .map(|item| item.value)
                                    .collect::<Vec<_>>(),
                                vec![8, 9]
                            );
                        }
                        runtime.stop().await;
                        let expected_clears =
                            u32::from(absolute || !fire || profile == Profile::Promise);
                        assert_eq!(
                            clock.clears.get(),
                            expected_clears,
                            "{profile:?}, absolute={absolute}, fire={fire}"
                        );
                        assert!(clock.pending.borrow().is_none());
                        assert_eq!(queue.borrow().len(), usize::from(fire));
                    }
                }
            }
        })
        .await;
}
