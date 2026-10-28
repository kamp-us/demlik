use demlik_tea::{
    PlainData, Tagged,
    agent::{
        tool::{self, ErrorFamily, ToolSpec},
        types::ToolCall,
    },
    command::{CommandContractError, CommandEdge, CommandFamily, Outcome, SchemaError},
    llm_call::Schema,
    resilience::resilient_call::CallValue,
};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};
struct In;
impl Schema for In {
    type Raw = Rc<()>;
    type Output = Rc<()>;
    type Error = SchemaError;
    fn parse(&self, raw: Rc<()>) -> Result<Rc<()>, CallValue<SchemaError>> {
        Ok(raw)
    }
}
struct Out(bool);
impl Schema for Out {
    type Raw = Rc<()>;
    type Output = Rc<()>;
    type Error = SchemaError;
    fn parse(&self, _: Rc<()>) -> Result<Rc<()>, CallValue<SchemaError>> {
        Err(if self.0 {
            CallValue::Undefined
        } else {
            CallValue::Missing
        })
    }
}
struct Never;
impl Tagged for Never {
    fn tag(&self) -> &str {
        "never"
    }
}
#[test]
fn unsupported_absent_schema_carriers_refuse_without_malformed_settlement() {
    for undefined in [false, true] {
        let calls = Rc::new(Cell::new(0));
        let parser_calls = Rc::clone(&calls);
        let def = tool::tool(
            "absent",
            ToolSpec::new(
                Rc::new(In),
                Rc::new(Out(undefined)),
                ErrorFamily::new(["never"], |_: &Never| Ok(PlainData::Null)),
            ),
            move |_: &Rc<()>, _: tool::ToolContext<'_, ()>| {
                parser_calls.set(parser_calls.get() + 1);
                Box::pin(async { Ok(Outcome::ok(Rc::new(()))) })
            },
        )
        .unwrap();
        let command = tool::ToolDefinition::command(
            &def,
            &ToolCall {
                call_id: "c".into(),
                name: "absent".into(),
                args: Rc::new(()),
            },
        )
        .unwrap();
        assert_eq!(calls.get(), 0);
        let error =
            match command.settle_in(Some(Outcome::ok(Rc::new(()))), &CommandEdge::new(|| 1.0)) {
                Err(e) => e,
                Ok(_) => panic!("missing carrier accepted"),
            };
        let CommandContractError::Outcome { detail, .. } = error else {
            panic!("refusal reclassified")
        };
        assert!(detail.contains(if undefined { "undefined" } else { "missing" }));
    }
}

struct Identity;
impl Schema for Identity {
    type Raw = Rc<()>;
    type Output = Rc<()>;
    type Error = SchemaError;
    fn parse(&self, raw: Rc<()>) -> Result<Rc<()>, CallValue<SchemaError>> {
        Ok(raw)
    }
}
demlik_tea::tool_router! {mod one {Only(only)}}
#[test]
fn name_reader_and_engine_dispatch_guard_keep_separate_authorities() {
    let def = tool::tool(
        "native_guard",
        ToolSpec::new(
            Rc::new(In),
            Rc::new(Identity),
            ErrorFamily::new(["never"], |_: &Never| Ok(PlainData::Null)),
        ),
        |_: &Rc<()>, _: tool::ToolContext<'_, ()>| Box::pin(async { Ok(Outcome::ok(Rc::new(()))) }),
    )
    .unwrap();
    let router = one::Router::new(def).unwrap();
    let call = ToolCall {
        call_id: "c".into(),
        name: "native_guard".into(),
        args: Rc::new(()),
    };
    let command = router.tool_of(&call).unwrap();
    let one::Commands::Only(c) = &command else {
        panic!("wrong command")
    };
    let definition = c.cmd().definition();
    let forged = one::Messages::Only(definition.ok(
        definition.from_record(tool::ToolInput {
            call_id: "forged".into(),
            args: Rc::new(()),
        }),
        Rc::new(()),
        Some(17.25),
    ));
    assert!(router.outcome_of(&forged).unwrap().is_some());
    let edge = CommandEdge::new(|| 17.25);
    let guard = command.dispatch_guard(&edge);
    assert!(guard.check(&forged).is_err());
    let messages = command
        .settle_in(
            one::Completions::Only(Some(Outcome::ok(Rc::new(())))),
            &edge,
        )
        .unwrap();
    guard.check(&messages[0]).unwrap();
    let other_edge = CommandEdge::new(|| 17.25);
    let other = router.tool_of(&call).unwrap().dispatch_guard(&other_edge);
    assert!(other.check(&messages[0]).is_err());
    let command = router.tool_of(&call).unwrap();
    let result = command.settle_in(
        one::Completions::Rejected(Some(Outcome::err(tool::ToolRejection::UnknownTool {
            name: "missing".into(),
        }))),
        &edge,
    );
    assert!(matches!(
        result,
        Err(CommandContractError::CompletionMismatch { .. })
    ));
}
#[test]
fn missing_input_schema_carrier_is_an_observable_refusal() {
    for undefined in [false, true] {
        let def = tool::tool(
            "missing_input",
            ToolSpec::new(
                Rc::new(Out(undefined)),
                Rc::new(Identity),
                ErrorFamily::new(["never"], |_: &Never| Ok(PlainData::Null)),
            ),
            |_: &Rc<()>, _: tool::ToolContext<'_, ()>| {
                Box::pin(async { Ok(Outcome::ok(Rc::new(()))) })
            },
        )
        .unwrap();
        let router = one::Router::new(def).unwrap();
        let result = router.tool_of(&ToolCall {
            call_id: "c".into(),
            name: "missing_input".into(),
            args: Rc::new(()),
        });
        assert!(
            matches!(result,Err(tool::ToolError::MissingSchemaFailure{undefined:v}) if v==undefined)
        );
    }
}

struct Opaque {
    marker: Rc<Cell<u32>>,
}
struct OpaqueSchema;
impl Schema for OpaqueSchema {
    type Raw = Rc<Opaque>;
    type Output = Rc<Opaque>;
    type Error = SchemaError;
    fn parse(&self, raw: Rc<Opaque>) -> Result<Rc<Opaque>, CallValue<SchemaError>> {
        Ok(raw)
    }
}
struct OpaqueFailure(Rc<Opaque>);
impl Tagged for OpaqueFailure {
    fn tag(&self) -> &str {
        "unavailable"
    }
}
struct Services {
    port: demlik_tea::ports::Port<Rc<Opaque>>,
    result: Rc<Opaque>,
    cause: Rc<Opaque>,
    ready: RefCell<Option<tokio::sync::oneshot::Receiver<()>>>,
}
struct State {
    count: u32,
    result: Option<Rc<Opaque>>,
    failure: Option<Rc<Opaque>>,
}
impl Tagged for State {
    fn tag(&self) -> &str {
        "state"
    }
}
#[tokio::test(flavor = "current_thread")]
async fn actual_profiles_keep_opaque_payloads_and_forward_the_original_runtime_emitter() {
    use demlik_tea::{
        Machine, Step, Sub,
        runtime::{self, NoSubscriptions, Options, Profile},
    };
    use std::convert::Infallible;
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let marker = Rc::new(Cell::new(7));
                let (release, ready) = tokio::sync::oneshot::channel();
                let services = Rc::new(Services {
                    port: demlik_tea::ports::define_port(format!("tool-router-port-{profile:?}"))
                        .unwrap(),
                    result: Rc::new(Opaque {
                        marker: Rc::clone(&marker),
                    }),
                    cause: Rc::new(Opaque {
                        marker: Rc::clone(&marker),
                    }),
                    ready: RefCell::new(Some(ready)),
                });
                let def = tool::tool(
                    "native_opaque",
                    ToolSpec::new(
                        Rc::new(OpaqueSchema),
                        Rc::new(OpaqueSchema),
                        ErrorFamily::new(["unavailable"], |_: &OpaqueFailure| {
                            Ok(PlainData::Object(
                                [("_tag".into(), PlainData::String("unavailable".into()))]
                                    .into_iter()
                                    .collect(),
                            ))
                        }),
                    ),
                    |arg: &Rc<Opaque>, ctx: tool::ToolContext<'_, Services>| {
                        Box::pin(async move {
                            if arg.marker.get() == 8 {
                                return Err(tool::Raised::Declared(Rc::new(OpaqueFailure(
                                    Rc::clone(&ctx.host.cause),
                                ))));
                            }
                            let ready = ctx.host.ready.borrow_mut().take();
                            if let Some(ready) = ready {
                                ready.await.unwrap();
                            }
                            ctx.emit(&ctx.host.port, &ctx.host.result).unwrap();
                            assert_eq!(ctx.host.cause.marker.get(), 7);
                            Ok(Outcome::ok(Rc::clone(&ctx.host.result)))
                        })
                    },
                )
                .unwrap();
                let router = Rc::new(one::Router::new(def).unwrap());
                let init = Rc::clone(&router);
                let update = Rc::clone(&router);
                let raw = Rc::clone(&services.result);
                let machine = Machine {
                    init: Box::new(move |_, _: &()| {
                        Step::new(
                            State {
                                count: 0,
                                result: None,
                                failure: None,
                            },
                            vec![
                                init.tool_of(&ToolCall {
                                    call_id: "native".into(),
                                    name: "native_opaque".into(),
                                    args: Rc::clone(&raw),
                                })
                                .unwrap(),
                                init.tool_of(&ToolCall {
                                    call_id: "failed".into(),
                                    name: "native_opaque".into(),
                                    args: Rc::new(Opaque {
                                        marker: Rc::new(Cell::new(8)),
                                    }),
                                })
                                .unwrap(),
                            ],
                        )
                    }),
                    update: router.update(move |state: &State, msg| {
                        let outcome = update.outcome_of(msg).unwrap().unwrap();
                        let mut result = state.result.as_ref().map(Rc::clone);
                        let mut failure = state.failure.as_ref().map(Rc::clone);
                        match outcome.outcome {
                            demlik_tea::agent::types::ToolOutcome::Ok(value) => {
                                let one::Results::Only(original) = value.as_ref() else {
                                    panic!("wrong result")
                                };
                                result = Some(Rc::clone(original));
                            }
                            demlik_tea::agent::types::ToolOutcome::Error(value) => {
                                let one::Errors::Only(view) = value.as_ref() else {
                                    panic!("wrong failure")
                                };
                                let demlik_tea::command::Failure::Declared(
                                    tool::ToolFailure::Declared(original),
                                ) = &view.error
                                else {
                                    panic!("failure remapped")
                                };
                                failure = Some(Rc::clone(&original.0));
                            }
                        }
                        Step::new(
                            State {
                                count: state.count + 1,
                                result,
                                failure,
                            },
                            vec![],
                        )
                    }),
                    subscriptions: demlik_tea::core::subscriptions(|_: &State| {
                        Vec::<Sub<()>>::new()
                    }),
                };
                let mut options: Options<_, _, Infallible, tool::ToolError> = Options::new(profile);
                options.terminal = Some(Rc::new(|s: &State| s.count == 2));
                let live = runtime::launch(
                    machine,
                    (),
                    Rc::clone(&router).interpreter(Rc::clone(&services)),
                    NoSubscriptions::new(),
                    options,
                );
                let emissions = Rc::new(std::cell::RefCell::new(Vec::new()));
                let received = Rc::clone(&emissions);
                let _listener = live.subscribe_port(
                    &services.port,
                    Rc::new(move |v| received.borrow_mut().push(Rc::clone(v))),
                );
                release.send(()).unwrap();
                live.ready().await.unwrap();
                let state = live.done().await.unwrap();
                live.stop().await;
                drop(router);
                assert!(Rc::ptr_eq(state.result.as_ref().unwrap(), &services.result));
                assert!(Rc::ptr_eq(state.failure.as_ref().unwrap(), &services.cause));
                assert!(Rc::ptr_eq(&emissions.borrow()[0], &services.result));
                assert!(Rc::ptr_eq(&state.result.as_ref().unwrap().marker, &marker));
            }
        })
        .await;
}

#[test]
fn a_same_generic_foreign_name_refuses_before_any_other_handler() {
    let called = Rc::new(Cell::new(0));
    let make = |name: &str| {
        let calls = Rc::clone(&called);
        tool::tool(
            name,
            ToolSpec::new(
                Rc::new(In),
                Rc::new(Identity),
                ErrorFamily::new(["never"], |_: &Never| Ok(PlainData::Null)),
            ),
            move |_: &Rc<()>, _: tool::ToolContext<'_, ()>| {
                calls.set(calls.get() + 1);
                Box::pin(async { Ok(Outcome::ok(Rc::new(()))) })
            },
        )
        .unwrap()
    };
    let first = one::Router::new(make("first")).unwrap();
    let second = one::Router::new(make("second")).unwrap();
    let command = first
        .tool_of(&ToolCall {
            call_id: "c".into(),
            name: "first".into(),
            args: Rc::new(()),
        })
        .unwrap();
    let failure =
        futures::executor::block_on(second.interpret(&command, tool::ToolContext::bare(&())));
    assert!(matches!(
        failure,
        Err(tool::ToolError::Contract(
            CommandContractError::CompletionMismatch { .. }
        ))
    ));
    assert_eq!(called.get(), 0);
    let completed =
        futures::executor::block_on(first.interpret(&command, tool::ToolContext::bare(&())));
    assert!(completed.is_ok());
    assert_eq!(called.get(), 1);
}
