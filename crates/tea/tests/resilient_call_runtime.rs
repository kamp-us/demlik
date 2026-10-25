use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::resilience::deadline::DeadlineExceeded;
use demlik_tea::resilience::resilient_call::{
    CallFailure, CallPhase, CallValue, Config, DeadlineConfig, ResilientCall, State,
};
use demlik_tea::runtime::{NoInterpreter, NoSubscriptions, Options, Profile, launch};
use demlik_tea::{Machine, Step, Sub, Tagged, TimerDeps, Update};
use std::{cell::Cell, convert::Infallible, rc::Rc, time::Duration};

struct Model {
    call: State<(), (), ()>,
    delivered: Rc<Cell<u32>>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
enum Command {}
impl Tagged for Command {
    fn tag(&self) -> &str {
        match *self {}
    }
}
impl CommandFamily for Command {
    type Msg = DeadlineExceeded;
    type Completion = Vec<DeadlineExceeded>;
    fn settle(self, _: Self::Completion, _: f64) -> Result<Vec<Self::Msg>, CommandContractError> {
        match self {}
    }
}

#[tokio::test(flavor = "current_thread")]
async fn resilient_timer_uses_the_actual_default_runtime_in_both_profiles() {
    tokio::task::LocalSet::new().run_until(async {
        for profile in [Profile::Promise, Profile::Effect] {
            let knob: Rc<ResilientCall<'static, (), (), ()>> = Rc::new(ResilientCall::new(Config {
                name: "native".into(),
                deadline: Some(DeadlineConfig { ms: 2.5 }),
                ..Config::default()
            }));
            // A durable running call can be restored before the host mounts.
            let running = knob.attempt(&knob.init(), "job", CallValue::value(()), 17.25).unwrap();
            assert_eq!(running.commands.len(), 1);
            let restored: State<(), (), ()> = serde_json::from_str(&serde_json::to_string(&running.state).unwrap()).unwrap();
            let initial = Rc::new(std::cell::RefCell::new(Some(restored)));
            let updates = Rc::clone(&knob);
            let subscriptions = Rc::clone(&knob);
            let delivered = Rc::new(Cell::new(0));
            let seen = Rc::clone(&delivered);
            let mut cells: demlik_tea::core::Row<'static, Model, DeadlineExceeded, Command> = Default::default();
            cells.insert("native_deadline".into(), Box::new(move |state: &Model, msg: &DeadlineExceeded| {
                assert_eq!(msg.kind, "native_deadline");
                assert_eq!(msg.id.as_utf8(), Some("native:deadline:job"));
                assert_eq!(msg.at_ms.number(), Some(19.75));
                let next = updates.on_timer(&state.call, msg).unwrap();
                assert!(next.commands.is_empty());
                state.delivered.set(state.delivered.get()+1);
                Step::new(Model { call: next.state, delivered: Rc::clone(&state.delivered) }, vec![])
            }));
            let machine: Machine<'static, Model, DeadlineExceeded, Command, Sub<TimerDeps<DeadlineExceeded>>> = Machine {
                init: Box::new(move |loaded, _| Step::new(loaded.unwrap_or_else(|| Model {
                    call: initial.borrow_mut().take().unwrap(), delivered: Rc::clone(&seen),
                }), vec![])),
                update: Update::RawReducer(cells),
                subscriptions: demlik_tea::core::subscriptions(move |state: &Model| {
                    subscriptions.timer(&state.call).map(|deps: TimerDeps<DeadlineExceeded>| {
                        assert_eq!(deps.ms, 2.5);
                        Sub::new("timer", deps).unwrap()
                    }).into_iter().collect()
                }),
            };
            let mut options: Options<Model, DeadlineExceeded, Infallible, Infallible> = Options::new(profile);
            options.terminal = Some(Rc::new(|state: &Model| matches!(state.call.call("job"), Some(CallPhase::Failed {..}))));
            let runtime = launch(machine, (), NoInterpreter::new(), NoSubscriptions::new(), options);
            runtime.ready().await.unwrap();
            let final_state = tokio::time::timeout(Duration::from_secs(1), runtime.done()).await.unwrap().unwrap();
            assert_eq!(delivered.get(), 1);
            assert!(matches!(final_state.call.call("job"), Some(CallPhase::Failed {error}) if matches!(error.as_ref(),CallFailure::DeadlineExceeded {id,at_ms} if id.as_utf8()==Some("native:deadline:job") && at_ms.number()==Some(19.75))));
            runtime.stop().await;
            tokio::time::sleep(Duration::from_millis(5)).await;
            assert_eq!(delivered.get(), 1);
            eprintln!("resilient-runtime:{profile:?}:delivered:{}", delivered.get());
        }
    }).await;
}
