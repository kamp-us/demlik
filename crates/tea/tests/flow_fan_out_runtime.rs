use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::data::JsText;
use demlik_tea::flow::fan_out::{FanOut, FanOutConfig, FanOutPorts, FanOutState};
use demlik_tea::runtime::{
    self, CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Profile,
};
use demlik_tea::{Machine, Step, Sub, Tagged, Update, messages};
use std::{cell::RefCell, convert::Infallible, rc::Rc};
struct Input {
    id: JsText,
    n: u32,
    _local: Rc<()>,
}
struct Reply(u32);
messages! {enum Msg{Scatter{items:Vec<Rc<Input>>},Ok{id:JsText,result:Rc<Reply>},Reported{results:Vec<Rc<Reply>>}}}
enum Cmd {
    Launch(Rc<Input>),
    Report(Vec<Rc<Reply>>),
}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match self {
            Self::Launch(_) => "launch",
            Self::Report(_) => "report",
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
struct Host;
impl Interpreter<Cmd> for Host {
    type Error = Infallible;
    fn interpret<'a>(
        &'a self,
        command: &'a Cmd,
        _: CommandContext<Msg, Infallible>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Infallible>> {
        Some(CommandWork::new(async move {
            Ok(vec![match command {
                Cmd::Launch(input) => Msg::Ok {
                    id: input.id.clone(),
                    result: Rc::new(Reply(input.n * 10)),
                },
                Cmd::Report(results) => Msg::Reported {
                    results: results.clone(),
                },
            }])
        }))
    }
}
struct Model {
    fan: Rc<FanOutState<Input, Reply>>,
    reports: Rc<Vec<Vec<u32>>>,
}
impl Tagged for Model {
    fn tag(&self) -> &str {
        "model"
    }
}
#[tokio::test(flavor = "current_thread")]
async fn two_real_runtime_waves_fold_their_own_reports_and_emit_on_every_completed_commit() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let fan = Rc::new(
                    FanOut::new(FanOutConfig::new(
                        2.0,
                        |item: &Input| item.id.clone(),
                        |item: &Rc<Input>| Cmd::Launch(Rc::clone(item)),
                    ))
                    .with_join(|results: &[Rc<Reply>]| Cmd::Report(results.to_vec())),
                );
                let init = Rc::clone(&fan);
                let update = Rc::clone(&fan);
                let machine: Machine<'static, Model, Msg, Cmd, Sub> = Machine {
                    init: Box::new(move |_, _| {
                        Step::new(
                            Model {
                                fan: init.init(),
                                reports: Rc::new(vec![]),
                            },
                            vec![],
                        )
                    }),
                    update: Update::reducer(move |state: &Model, msg: &Msg| match msg {
                        Msg::Scatter { items } => {
                            let step = update.scatter(&state.fan, items.iter().cloned());
                            Step::new(
                                Model {
                                    fan: step.state,
                                    reports: Rc::clone(&state.reports),
                                },
                                step.commands,
                            )
                        }
                        Msg::Ok { id, result } => {
                            let step = update.item_ok(&state.fan, id, Rc::clone(result));
                            Step::new(
                                Model {
                                    fan: step.state,
                                    reports: Rc::clone(&state.reports),
                                },
                                step.commands,
                            )
                        }
                        Msg::Reported { results } => {
                            let mut reports = state.reports.as_ref().clone();
                            reports.push(results.iter().map(|value| value.0).collect());
                            Step::new(
                                Model {
                                    fan: Rc::clone(&state.fan),
                                    reports: Rc::new(reports),
                                },
                                vec![],
                            )
                        }
                    }),
                    subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
                };
                let options: Options<Model, Msg, Infallible, Infallible> = Options::new(profile);
                let runtime = runtime::launch(machine, (), Host, NoSubscriptions::new(), options);
                runtime.ready().await.unwrap();
                let port =
                    demlik_tea::ports::define_port(format!("flow.fan-out.runtime.{profile:?}"))
                        .unwrap();
                let completion = fan.completion(FanOutPorts {
                    complete: port.clone(),
                });
                let emitted = Rc::new(RefCell::new(vec![]));
                let events = Rc::clone(&emitted);
                let _port = runtime.subscribe_port(
                    &port,
                    Rc::new(move |results: &Vec<Rc<Reply>>| {
                        events
                            .borrow_mut()
                            .push(results.iter().map(|value| value.0).collect::<Vec<_>>())
                    }),
                );
                let sender = runtime.clone();
                let detach = runtime.observe(move |_, state| {
                    completion
                        .emit_on_complete(|port, values| sender.emit_port(port, values), &state.fan)
                });
                let item = |id: &str, n| {
                    Rc::new(Input {
                        id: id.into(),
                        n,
                        _local: Rc::new(()),
                    })
                };
                runtime
                    .dispatch(Msg::Scatter {
                        items: vec![item("dup", 1), item("dup", 2), item("three", 3)],
                    })
                    .await
                    .unwrap();
                runtime
                    .dispatch(Msg::Scatter {
                        items: vec![item("four", 4), item("five", 5)],
                    })
                    .await
                    .unwrap();
                assert_eq!(
                    &*runtime.get_state().unwrap().reports,
                    &vec![vec![10, 20, 30], vec![40, 50]]
                );
                assert_eq!(
                    &*emitted.borrow(),
                    &vec![
                        vec![10, 20, 30],
                        vec![10, 20, 30],
                        vec![40, 50],
                        vec![40, 50]
                    ]
                );
                detach();
                runtime.stop().await;
            }
        })
        .await;
}
