use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::ports::define_port;
use demlik_tea::runtime::{
    self, DriveOptions, EffectScope, NoInterpreter, NoSubscriptions, Options, Profile, ScopeExit,
};
use demlik_tea::{Machine, Step, Sub, Tagged, TimerDeps, Update, messages};
use std::{convert::Infallible, rc::Rc};
struct Model {
    phase: &'static str,
    local: Rc<()>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        self.phase
    }
}
messages! {#[derive(serde::Serialize)]#[serde(tag="type")]enum Msg{Start,Finished}}
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
struct Finished;
impl Tagged for Finished {
    fn tag(&self) -> &str {
        "finished"
    }
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let machine: Machine<'static, Model, Msg, Cmd, Sub<TimerDeps<Msg>>> = Machine {
                init: Box::new(|_, _| {
                    Step::new(
                        Model {
                            phase: "idle",
                            local: Rc::new(()),
                        },
                        vec![],
                    )
                }),
                update: Update::reducer(|s: &Model, msg: &Msg| {
                    Step::new(
                        Model {
                            phase: match msg {
                                Msg::Start => "waiting",
                                Msg::Finished => "done",
                            },
                            local: Rc::clone(&s.local),
                        },
                        vec![],
                    )
                }),
                subscriptions: demlik_tea::core::subscriptions(|s: &Model| {
                    if s.phase == "waiting" {
                        vec![Sub::timer(2.0, Msg::Finished).unwrap()]
                    } else {
                        vec![]
                    }
                }),
            };
            let options: Options<Model, Msg, Infallible, Infallible> =
                Options::new(Profile::Effect);
            let runtime = runtime::launch(
                machine,
                (),
                NoInterpreter::new(),
                NoSubscriptions::new(),
                options.with_events(|msg, _| {
                    if matches!(msg, Msg::Finished) {
                        vec![Finished]
                    } else {
                        vec![]
                    }
                }),
            );
            let output = define_port::<String>("runtime-local-job.finished").unwrap();
            let _printed =
                runtime.subscribe_port(&output, Rc::new(|message: &String| println!("{message}")));
            let sender = runtime.clone();
            let token = output.clone();
            let detach = runtime.on(
                "finished",
                Rc::new(move |_: &Finished| sender.emit_port(&token, "Job finished".into())),
            );
            let scope = EffectScope::new();
            scope.attach(&runtime).await.unwrap();
            let result = scope
                .run(async move {
                    runtime::drive_to_done(
                        &runtime,
                        Msg::Start,
                        |s: &Model| s.phase == "done",
                        DriveOptions::default(),
                    )
                    .await
                })
                .await;
            detach();
            match result {
                ScopeExit::Success(state) => assert_eq!(state.phase, "done"),
                other => panic!(
                    "job did not complete: {}",
                    match other {
                        ScopeExit::Failure(_) => "drive failure",
                        ScopeExit::Defect(_) => "host defect",
                        ScopeExit::RuntimeFailure(_) => "runtime failure",
                        ScopeExit::Interrupted => "interrupted",
                        ScopeExit::Success(_) => unreachable!(),
                    }
                ),
            }
            assert!(scope.is_closed());
        })
        .await;
}
