use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::data::JsText;
use demlik_tea::resilience::deadline::{self, DeadlineExceeded};
use demlik_tea::runtime::{self, NoInterpreter, NoSubscriptions, Options, Profile, RuntimeTimer};
use demlik_tea::timing::{Timer, TimerCallback, TimerError};
use demlik_tea::{Machine, Step, Sub, Tagged, Update};
use std::{cell::RefCell, convert::Infallible, rc::Rc, time::Duration};
struct Model {
    delivered: Option<(JsText, deadline::DeadlineNumber)>,
    local: Rc<()>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
enum Cmd {}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match *self {}
    }
}
impl CommandFamily for Cmd {
    type Msg = DeadlineExceeded;
    type Completion = Vec<DeadlineExceeded>;
    fn settle(
        self,
        _: Self::Completion,
        _: f64,
    ) -> Result<Vec<DeadlineExceeded>, CommandContractError> {
        match self {}
    }
}
#[derive(Default)]
struct Host {
    delays: RefCell<Vec<f64>>,
    pending: RefCell<Option<TimerCallback>>,
}
impl Timer for Host {
    type Handle = ();
    fn now_ms(&self) -> f64 {
        100.25
    }
    fn set_timeout(&self, ms: f64, callback: TimerCallback) -> Result<(), TimerError> {
        self.delays.borrow_mut().push(ms);
        *self.pending.borrow_mut() = Some(callback);
        Ok(())
    }
    fn clear_timeout(&self, _: &()) {
        self.pending.borrow_mut().take();
    }
}
fn machine()
-> Machine<'static, Model, DeadlineExceeded, Cmd, Sub<deadline::TimerDeps<DeadlineExceeded>>> {
    let mut cells: demlik_tea::core::Row<'static, Model, DeadlineExceeded, Cmd> =
        Default::default();
    cells.insert(
        "deadline_exceeded".into(),
        Box::new(|s: &Model, msg: &DeadlineExceeded| {
            Step::new(
                Model {
                    delivered: Some((msg.id.clone(), msg.at_ms)),
                    local: Rc::clone(&s.local),
                },
                vec![],
            )
        }),
    );
    Machine {
        init: Box::new(|loaded, _| {
            Step::new(
                loaded.unwrap_or(Model {
                    delivered: None,
                    local: Rc::new(()),
                }),
                vec![],
            )
        }),
        update: Update::raw_reducer(cells),
        subscriptions: demlik_tea::core::subscriptions(|s: &Model| {
            if s.delivered.is_some() {
                return vec![];
            }
            let deps =
                deadline::next_timer(&[deadline::deadline_sub("watch", 130.5)], 100.25).unwrap();
            vec![Sub::new("timer", deps).unwrap()]
        }),
    }
}
#[tokio::test(flavor = "current_thread")]
async fn deadline_next_timer_data_runs_through_the_automatic_builtin_and_preserves_remaining_delay()
{
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let host = Rc::new(Host::default());
                let mut options: Options<Model, DeadlineExceeded, Infallible, Infallible> =
                    Options::new(profile);
                options.timer = Some(RuntimeTimer::new(Rc::clone(&host)));
                options.terminal = Some(Rc::new(|s: &Model| s.delivered.is_some()));
                let runtime = runtime::launch(
                    machine(),
                    (),
                    NoInterpreter::new(),
                    NoSubscriptions::new(),
                    options,
                );
                runtime.ready().await.unwrap();
                assert_eq!(&*host.delays.borrow(), &[30.25]);
                host.pending.borrow_mut().take().unwrap()().unwrap();
                let state = tokio::time::timeout(Duration::from_secs(1), runtime.done())
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(state.delivered, Some(("watch".into(), 130.5.into())));
                runtime.stop().await;
            }
        })
        .await;
}
