use super::*;
use demlik_tea::{agent::model::plain_model, file_store::file_store, storage::Migrated};
use std::convert::Infallible;
use tokio::sync::Notify;
struct Row {
    at: f64,
    callback: Option<TimerCallback>,
}
struct Context {
    shared: Rc<Shared>,
    directory: PathBuf,
    mode: String,
    scenario: String,
    now: Cell<f64>,
    trace: RefCell<Vec<Value>>,
    timers: RefCell<Vec<Row>>,
    timer_log: RefCell<Vec<Value>>,
    models: Cell<usize>,
    tools: Cell<usize>,
    compacts: Cell<usize>,
    entered: Notify,
    compact_entered: Cell<bool>,
    deadline: Notify,
    deadline_commits: Cell<usize>,
    cause: RefCell<Option<Weak<StructuredOutputError>>>,
    cause_same: Cell<bool>,
    guard_errors: Cell<usize>,
    guard_checks: Cell<usize>,
    loaded: RefCell<Option<Weak<State>>>,
}
impl Context {
    fn note(&self, v: Value) {
        self.trace.borrow_mut().push(v);
    }
    fn fire(&self) -> bool {
        let selected = self
            .timers
            .borrow()
            .iter()
            .enumerate()
            .filter(|(_, r)| r.callback.is_some())
            .min_by(|(_, a), (_, b)| a.at.total_cmp(&b.at))
            .map(|(i, _)| i);
        let Some(i) = selected else { return false };
        let (at, callback) = {
            let mut rows = self.timers.borrow_mut();
            let row = &mut rows[i];
            (row.at, row.callback.take().unwrap())
        };
        self.now.set(at);
        self.timer_log.borrow_mut().push(json!(["fire", at]));
        callback().unwrap();
        true
    }
}
struct ManualTimer(Rc<Context>);
impl Timer for ManualTimer {
    type Handle = usize;
    fn now_ms(&self) -> f64 {
        self.0.now.get()
    }
    fn set_timeout(&self, ms: f64, callback: TimerCallback) -> Result<usize, TimerError> {
        let at = self.0.now.get() + ms;
        let mut rows = self.0.timers.borrow_mut();
        let id = rows.len();
        rows.push(Row {
            at,
            callback: Some(callback),
        });
        self.0.timer_log.borrow_mut().push(json!(["arm", at]));
        Ok(id)
    }
    fn clear_timeout(&self, id: &usize) {
        let at = {
            let mut rows = self.0.timers.borrow_mut();
            let row = &mut rows[*id];
            row.callback = None;
            row.at
        };
        self.0.timer_log.borrow_mut().push(json!(["cancel", at]));
    }
}
struct Loader(Rc<Context>);
struct Message(Rc<Request<JsText, BrainPayload>>);
impl MessageLoader<JsText, BrainPayload, Message, StructuredOutputError> for Loader {
    async fn load<'a>(
        &'a self,
        request: &'a Rc<Request<JsText, BrainPayload>>,
    ) -> Result<Messages<'a, Message>, CallValue<StructuredOutputError>>
    where
        Message: 'a,
    {
        let history = &request.payload.conversation;
        self.0.note(json!([
            "load",
            history.turns.len(),
            history.turns.first().map(wire)
        ]));
        Ok(vec![Message(Rc::clone(request))].into())
    }
}
struct Tools(Rc<Context>);
impl Interpreter<Tool, Msg> for Tools {
    type Error = AgentWorkError<Infallible>;
    fn interpret<'a>(
        &'a self,
        command: &'a Tool,
        _: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<AgentToolMsg<PlainData>>, Self::Error>> {
        Some(CommandWork::new(async move {
            let name = command.0.name().as_utf8().unwrap();
            self.0.tools.set(self.0.tools.get() + 1);
            self.0.note(json!(["tool", name]));
            let text = tokio::fs::read_to_string(self.0.directory.join("invoice.json"))
                .await
                .unwrap();
            let invoice: Value = serde_json::from_str(&text).unwrap();
            let result = if name == "collect" {
                invoice
            } else {
                assert_eq!(name, "check");
                let sum: f64 = invoice["lines"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_f64().unwrap())
                    .sum();
                assert_eq!(sum, invoice["total"].as_f64().unwrap());
                let result = json!({"valid":true,"total":sum});
                tokio::fs::write(self.0.directory.join("validated.json"), result.to_string())
                    .await
                    .unwrap();
                result
            };
            Ok(vec![AgentToolMsg::Ok {
                call_id: command.0.call_id().clone(),
                result: Rc::new(plain(result)),
                at: self.0.now.get(),
            }])
        }))
    }
}
struct Compact(Rc<Context>);
impl Interpreter<CompactRun<CompactPayload, Rc<PlainData>, StructuredOutputError>, Msg>
    for Compact
{
    type Error = AgentWorkError<Infallible>;
    fn interpret<'a>(
        &'a self,
        command: &'a CompactRun<CompactPayload, Rc<PlainData>, StructuredOutputError>,
        _: CommandContext<Msg, Self::Error>,
    ) -> Option<
        CommandWork<'a, Vec<CompactMessage<Rc<PlainData>, StructuredOutputError>>, Self::Error>,
    > {
        Some(CommandWork::new(async move {
            let n = self.0.compacts.get();
            self.0.compacts.set(n + 1);
            self.0.note(json!(["compact", wire(&command.input)]));
            if self.0.mode == "writer" {
                self.0.compact_entered.set(true);
                self.0.entered.notify_waiters();
                std::future::pending::<()>().await;
            }
            if self.0.scenario.starts_with("cancel") {
                return Ok(vec![]);
            }
            let bad = self.0.scenario == "exhaust" || (self.0.scenario == "retry" && n == 0);
            let raw = Rc::new(plain(if bad {
                json!({"summary":7,"unknownSummary":{"kept":true}})
            } else {
                json!({"summary":"invoice inv-17 total=15 checked","unknownSummary":{"kept":true}})
            }));
            let result = observe!(
                self.0.shared.calls,
                Schema::parse,
                &COMPACTION_SUMMARY_SCHEMA,
                Rc::clone(&raw)
            );
            let msg = match result {
                Ok(output) => {
                    assert!(Rc::ptr_eq(&output, &raw));
                    self.0.shared.summary.replace(Some(Rc::downgrade(&output)));
                    CompactMessage::Ok(CompactOk {
                        key: command.key.clone(),
                        result: Rc::new(LlmOk {
                            key: command.key.clone(),
                            purpose: CompactionPurpose::Compact,
                            output,
                        }),
                        at: self.0.now.get(),
                    })
                }
                Err(CallValue::Shared(cause)) => {
                    self.0.guard_errors.set(self.0.guard_errors.get() + 1);
                    self.0.cause.replace(Some(Rc::downgrade(&cause)));
                    CompactMessage::Err(CompactErr {
                        key: command.key.clone(),
                        error: Rc::new(LlmErr {
                            key: command.key.clone(),
                            purpose: CompactionPurpose::Compact,
                            reason: cause.describe().unwrap(),
                            error: LlmCause::Value(cause),
                        }),
                        at: self.0.now.get(),
                    })
                }
                Err(_) => panic!("guard returns its actual error"),
            };
            Ok(vec![msg])
        }))
    }
}
fn turn(name: &str) -> Rc<PlainData> {
    Rc::new(plain(if name == "done" {
        json!({"content":"invoice verified:15","toolCalls":[],"unknownTurn":{"final":true}})
    } else {
        json!({"content":name,"toolCalls":[{"callId":format!("{name}-1"),"name":name,"args":{"path":"invoice.json","unknownArg":[1,null]},"unknownCall":{"kept":true}}],"usage":{"inputTokens":7,"outputTokens":2},"unknownTurn":{"kept":true}})
    }))
}

pub async fn run(input: Input) -> Value {
    let directory = input.path.expect("owned fixture directory");
    std::fs::create_dir_all(&directory).unwrap();
    let mode = input.mode.clone();
    let scenario = input.scenario.unwrap_or_else(|| "normal".to_owned());
    if mode != "reader" {
        tokio::fs::write(
            directory.join("invoice.json"),
            r#"{"id":"inv-17","lines":[4.5,10.5],"total":15}"#,
        )
        .await
        .unwrap();
    }
    let shared = Shared::new();
    let ctx = Rc::new(Context {
        shared: Rc::clone(&shared),
        directory: directory.clone(),
        mode: mode.clone(),
        scenario,
        now: Cell::new(if mode == "reader" { 57.25 } else { 17.25 }),
        trace: RefCell::new(vec![]),
        timers: RefCell::new(vec![]),
        timer_log: RefCell::new(vec![]),
        models: Cell::new(0),
        tools: Cell::new(0),
        compacts: Cell::new(0),
        entered: Notify::new(),
        compact_entered: Cell::new(false),
        deadline: Notify::new(),
        deadline_commits: Cell::new(0),
        cause: RefCell::new(None),
        cause_same: Cell::new(true),
        guard_errors: Cell::new(0),
        guard_checks: Cell::new(0),
        loaded: RefCell::new(None),
    });
    let knob = agent(input.config, Rc::clone(&shared));
    let model_ctx = Rc::clone(&ctx);
    let model = plain_model(async move |messages: Messages<'_, Message>| {
        let request = &messages.as_ref()[0].0;
        let n = model_ctx.models.get();
        model_ctx.models.set(n + 1);
        model_ctx.note(json!(["model", request.purpose]));
        let name = if model_ctx.mode == "reader" || n >= 2 {
            "done"
        } else if n == 0 {
            "collect"
        } else {
            "check"
        };
        Ok(turn(name))
    });
    let wired = observe!(
        shared.calls,
        demlik_tea::agent::Agent::to_machine_with_compaction,
        Rc::clone(&knob),
        model,
        Loader(Rc::clone(&ctx)),
        Tools(Rc::clone(&ctx)),
        Compact(Rc::clone(&ctx)),
        Rc::new(ManualTimer(Rc::clone(&ctx)))
    );
    let parse_ctx = Rc::clone(&ctx);
    let store = file_store(directory.join("state.json"), move |raw| {
        let value = serde_json::from_str::<State>(&demlik_tea::data::stringify_json(&raw).unwrap());
        match value {
            Ok(state) => {
                let state = Rc::new(state);
                parse_ctx.loaded.replace(Some(Rc::downgrade(&state)));
                Migrated::State(state)
            }
            Err(_) => Migrated::Fresh,
        }
    });
    let mut options = Options::new(if input.profile.as_deref() == Some("effect") {
        Profile::Effect
    } else {
        Profile::Promise
    });
    options.store = Some(runtime::Persistence::new(store));
    let clock = Rc::clone(&ctx);
    options.clock = Rc::new(move || clock.now.get());
    options.terminal = Some(Rc::new(|state: &Rc<State>| state.is_settled()));
    let run = observe!(
        shared.calls,
        runtime::try_launch,
        wired.machine,
        (),
        wired.interpret,
        wired.subscribe,
        options
    );
    observe!(shared.calls, runtime::Runtime::ready, &run)
        .await
        .unwrap();
    let ready = run.get_state().unwrap();
    let ready_view = wire(ready.as_ref());
    let ready_counts = json!([ctx.models.get(), ctx.tools.get(), ctx.compacts.get()]);
    let loaded_checks = usize::from(ctx.loaded.borrow().is_some());
    let ready_same = ctx.loaded.borrow().as_ref().is_none_or(|weak| {
        weak.upgrade()
            .is_some_and(|loaded| Rc::ptr_eq(&loaded, ready.as_ref()))
    });
    let observer = Rc::clone(&ctx);
    let _off = run.observe(move |message, state| {
        observer.note(json!([
            "commit",
            message.tag(),
            state.conversation.as_ref().map(|c| wire(&c.awaiting))
        ]));
        if let AgentMachineMsg::Compact(CompactMessage::Err(msg)) = message {
            let tracker={observer.cause.borrow_mut().take()};
            if let Some(tracker)=tracker {
                observer.guard_checks.set(observer.guard_checks.get()+1);
                let same=tracker.upgrade().is_some_and(|expected| {
                    matches!(&msg.error.error,LlmCause::Value(actual) if Rc::ptr_eq(actual,&expected))
                });
                observer.cause_same.set(observer.cause_same.get()&&same);
            }
        }
        if matches!(message, AgentMachineMsg::Deadline(_)) {
            observer
                .deadline_commits
                .set(observer.deadline_commits.get() + 1);
            observer.deadline.notify_waiters();
        }
    });
    let message: Msg = if mode == "reader" {
        Msg::boot(ctx.now.get())
    } else {
        AgentMachineMsg::Start {
            run_id: "invoice-run".into(),
            at: ctx.now.get(),
        }
    };
    if mode == "writer" {
        let dispatch = run.dispatch(message);
        tokio::pin!(dispatch);
        while !ctx.compact_entered.get() {
            let changed = ctx.entered.notified();
            tokio::select! {answer=&mut dispatch=>panic!("writer escaped pending compaction: {answer:?}"),_=changed=>{}}
        }
        let checkpoint = tokio::fs::read_to_string(directory.join("state.json"))
            .await
            .unwrap();
        return json!({"id":input.id,"view":{"ready":ready_view,"readyCounts":ready_counts,"readySame":ready_same,"identityDomains":{"loaded":{"status":if loaded_checks>0{"tracked"}else{"not-applicable"},"checks":loaded_checks},"guard":{"status":if ctx.guard_errors.get()>0{"tracked"}else{"not-applicable"},"errors":ctx.guard_errors.get(),"checks":ctx.guard_checks.get()}},"checkpoint":serde_json::from_str::<Value>(&checkpoint).unwrap(),"trace":ctx.trace.borrow().clone(),"timerLog":ctx.timer_log.borrow().clone(),"counts":[ctx.models.get(),ctx.tools.get(),ctx.compacts.get()],"policyLog":shared.log.borrow().clone()},"checkpointBytes":checkpoint,"observedCalls":shared.calls.borrow().clone()});
    }
    observe!(shared.calls, runtime::Runtime::dispatch, &run, message)
        .await
        .unwrap();
    if ctx.scenario.starts_with("cancel") {
        observe!(
            shared.calls,
            runtime::Runtime::dispatch,
            &run,
            Msg::cancel(ctx.now.get())
        )
        .await
        .unwrap();
        let msg = if ctx.scenario == "cancel-late-error" {
            let cause = StructuredOutputError::Plain(Rc::new(plain(json!({"late":true}))));
            CompactMessage::Err(CompactErr {
                key: "$compact".into(),
                error: Rc::new(LlmErr {
                    key: "$compact".into(),
                    purpose: CompactionPurpose::Compact,
                    reason: "late".into(),
                    error: LlmCause::Value(Rc::new(cause)),
                }),
                at: ctx.now.get(),
            })
        } else {
            CompactMessage::Ok(CompactOk {
                key: "$compact".into(),
                result: Rc::new(LlmOk {
                    key: "$compact".into(),
                    purpose: CompactionPurpose::Compact,
                    output: Rc::new(plain(json!({"summary":"late"}))),
                }),
                at: ctx.now.get(),
            })
        };
        observe!(
            shared.calls,
            runtime::Runtime::dispatch,
            &run,
            AgentMachineMsg::Compact(msg)
        )
        .await
        .unwrap();
    }
    for _ in 0..5 {
        if run.get_state().unwrap().is_settled() {
            break;
        }
        let before = ctx.deadline_commits.get();
        if !ctx.fire() {
            break;
        }
        while ctx.deadline_commits.get() == before {
            ctx.deadline.notified().await;
        }
        observe!(shared.calls, runtime::Runtime::idle, &run)
            .await
            .unwrap();
    }
    let final_state = run.get_state().unwrap();
    let done_same = if final_state.is_settled() {
        let done = run.done().await.unwrap();
        let result = run.result().unwrap();
        std::sync::Arc::ptr_eq(&done, &final_state) && std::sync::Arc::ptr_eq(&result, &final_state)
    } else {
        false
    };
    observe!(shared.calls, runtime::Runtime::stop, &run).await;
    let checkpoint = tokio::fs::read_to_string(directory.join("state.json"))
        .await
        .unwrap();
    let summary_same=shared.summary.borrow().as_ref().is_none_or(|weak|weak.upgrade().is_some_and(|root| {
        final_state.compaction.value().is_some_and(|slice|matches!(slice.call("$compact"),Some(demlik_tea::resilience::resilient_call::CallPhase::Succeeded{result:CallValue::Shared(value)}) if Rc::ptr_eq(&value.output,&root)))
    }));
    json!({"id":input.id,"view":{"ready":ready_view,"readyCounts":ready_counts,"readySame":ready_same,"identityDomains":{"loaded":{"status":if loaded_checks>0{"tracked"}else{"not-applicable"},"checks":loaded_checks},"guard":{"status":if ctx.guard_errors.get()>0{"tracked"}else{"not-applicable"},"errors":ctx.guard_errors.get(),"checks":ctx.guard_checks.get()}},"state":wire(final_state.as_ref()),"checkpoint":serde_json::from_str::<Value>(&checkpoint).unwrap(),"trace":ctx.trace.borrow().clone(),"timerLog":ctx.timer_log.borrow().clone(),"counts":[ctx.models.get(),ctx.tools.get(),ctx.compacts.get()],"policyLog":shared.log.borrow().clone(),"doneSame":done_same,"payloadSame":shared.payload_same.get(),"summarySame":summary_same,"causeSame":ctx.cause_same.get()},"checkpointBytes":checkpoint,"observedCalls":shared.calls.borrow().clone()})
}
