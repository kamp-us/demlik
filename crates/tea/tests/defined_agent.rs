use demlik_tea::{
    PlainData,
    agent::{
        DefineAgentConfig, DefinedAgentRunOptions, define_agent,
        defined::{DefinedAgentMessage, DefinedAgentModelError},
        model::{Messages, plain_model},
        tool::EmptyRouter,
        types::AgentEvent,
    },
    data::decode_json,
    resilience::resilient_call::CallValue,
};
use demlik_tea::{
    Tagged,
    agent::{
        DefinedAgentTools, PlainToolArgs,
        tool::{self, ErrorFamily, ToolDefinition, ToolSpec},
    },
    command::{Issue, SchemaError},
    llm_call::Schema,
};
use serde::Serialize;
use std::{cell::Cell, convert::Infallible, rc::Rc};
use std::{cell::RefCell, collections::VecDeque};
use tokio::sync::Notify;
demlik_tea::tool_router! { mod single { Known(known) } }

struct InvoiceInput;
impl Schema for InvoiceInput {
    type Raw = Rc<PlainToolArgs>;
    type Output = Rc<()>;
    type Error = SchemaError;
    fn parse(&self, raw: Self::Raw) -> Result<Self::Output, CallValue<SchemaError>> {
        if matches!(raw.value(), PlainData::Object(fields) if matches!(fields.get("file"),Some(PlainData::String(_))))
        {
            Ok(Rc::new(()))
        } else {
            Err(CallValue::value(SchemaError::Issues(vec![Issue::new(
                "file", "string",
            )])))
        }
    }
}
struct UnitOutput;
impl Schema for UnitOutput {
    type Raw = ();
    type Output = Rc<()>;
    type Error = SchemaError;
    fn parse(&self, _: ()) -> Result<Rc<()>, CallValue<SchemaError>> {
        Ok(Rc::new(()))
    }
}
enum NoErrors {}
impl Tagged for NoErrors {
    fn tag(&self) -> &str {
        match *self {}
    }
}
fn known_tool() -> Rc<impl ToolDefinition<Host = (), RawArgs = PlainToolArgs>> {
    tool::tool(
        "known",
        ToolSpec::new(
            Rc::new(InvoiceInput),
            Rc::new(UnitOutput),
            ErrorFamily::new(
                std::iter::empty::<&str>(),
                |error: &NoErrors| match *error {},
            ),
        ),
        |_, _| Box::pin(async { panic!("a rejected call cannot enter the tool handler") }),
    )
    .unwrap()
}
async fn rejection<R>(router: Rc<R>, name: &'static str, tag: &'static str)
where
    R: DefinedAgentTools<Host = ()>,
    R::Error: Serialize,
{
    let replies=RefCell::new(VecDeque::from([
        Rc::new(decode_json(&format!(r#"{{"content":"try","toolCalls":[{{"callId":"rejected-17","name":"{name}","args":{{"wrong":"input"}}}}]}}"#)).unwrap()),
        Rc::new(decode_json(r#"{"content":"recovered","toolCalls":[]}"#).unwrap()),
    ]));
    let model = plain_model(
        async move |_: Messages<'_, DefinedAgentMessage<R>>| -> Result<
            Rc<PlainData>,
            CallValue<DefinedAgentModelError<R::ContentError>>,
        > { Ok(replies.borrow_mut().pop_front().unwrap()) },
    );
    let hooks = Rc::new(RefCell::new(Vec::new()));
    let captured = Rc::clone(&hooks);
    let config = DefineAgentConfig::new(model, router, "recover from rejection").on_tool_error(
        move |failure| {
            let receipt = serde_json::json!({"context":failure.context,"outcome":failure.outcome});
            let capture = Rc::clone(&captured);
            Box::pin(async move {
                tokio::task::yield_now().await;
                capture.borrow_mut().push(receipt);
            })
        },
    );
    let during = Rc::clone(&hooks);
    let order = Rc::new(RefCell::new(Vec::new()));
    let observed_order = Rc::clone(&order);
    let final_state = define_agent(config)
        .run(
            "recover",
            DefinedAgentRunOptions::new(Rc::new(())).on_event(move |event| {
                if matches!(event, AgentEvent::ToolFailed { .. }) {
                    observed_order.borrow_mut().push(during.borrow().len());
                }
            }),
        )
        .await
        .unwrap();
    assert!(final_state.is_settled());
    assert_eq!(
        &*order.borrow(),
        &[1],
        "rejection hook must be awaited before folding and publishing the failure"
    );
    let hooks = hooks.borrow();
    assert_eq!(
        hooks.len(),
        1,
        "every routed rejection must reach the hook exactly once"
    );
    assert_eq!(
        hooks[0]["context"],
        serde_json::json!({"callId":"rejected-17","name":name})
    );
    assert_eq!(hooks[0]["outcome"]["_tag"], tag);
}

#[test]
fn unknown_and_malformed_rejections_await_the_hook_in_empty_and_generated_routers() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&runtime, async {
        rejection(Rc::new(EmptyRouter), "missing", "unknown_tool").await;
        rejection(
            Rc::new(single::Router::new(known_tool()).unwrap()),
            "missing",
            "unknown_tool",
        )
        .await;
        rejection(
            Rc::new(single::Router::new(known_tool()).unwrap()),
            "known",
            "malformed_args",
        )
        .await;
    });
}

#[test]
fn unpolled_promise_run_starts_and_dropped_waiter_keeps_the_drive_and_events_alive() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&runtime, async {
        let called = Rc::new(Cell::new(0));
        let ended = Rc::new(Cell::new(0));
        let release = Rc::new(Notify::new());
        let calls = Rc::clone(&called);
        let gate = Rc::clone(&release);
        let model =
            plain_model(
                async move |_: Messages<'_, DefinedAgentMessage<EmptyRouter>>| -> Result<
                    Rc<PlainData>,
                    CallValue<DefinedAgentModelError<Infallible>>,
                > {
                    calls.set(calls.get() + 1);
                    gate.notified().await;
                    Ok(Rc::new(
                        decode_json(r#"{"content":"done","toolCalls":[]}"#).unwrap(),
                    ))
                },
            );
        let agent = define_agent(DefineAgentConfig::new(
            model,
            Rc::new(EmptyRouter),
            "finish",
        ));
        let done = Rc::clone(&ended);
        let run_ids = Rc::new(RefCell::new(Vec::new()));
        let ids = Rc::clone(&run_ids);
        let waiter = agent.run(
            "one task",
            DefinedAgentRunOptions::new(Rc::new(())).on_event(move |event| {
                if let AgentEvent::RunDone { head, .. } = event {
                    ids.borrow_mut()
                        .push(head.run_id.as_utf8().unwrap().to_owned());
                    done.set(done.get() + 1);
                }
            }),
        );
        for _ in 0..100 {
            if called.get() != 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(
            called.get(),
            1,
            "calling run starts the Promise drive before polling its receipt"
        );
        assert_eq!(
            ended.get(),
            0,
            "the actual model operation is still awaiting its host"
        );
        drop(waiter);
        drop(agent);
        release.notify_one();
        for _ in 0..100 {
            if ended.get() != 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(
            ended.get(),
            1,
            "the owned drive finishes and delivers its final event after the caller drops"
        );
        assert_eq!(called.get(), 1);
        let ids = run_ids.borrow();
        let id = ids
            .first()
            .expect("the completed event retains its generated run ID")
            .as_bytes();
        assert_eq!(id.len(), 36);
        for at in [8, 13, 18, 23] {
            assert_eq!(id[at], b'-');
        }
        assert_eq!(
            id[14], b'4',
            "default run IDs use UUID v4 like the TypeScript reference"
        );
        assert!(matches!(id[19], b'8' | b'9' | b'a' | b'b'));
    });
}
