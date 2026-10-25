use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::persistence::recorder::{RecorderOptions, StateKind};
use demlik_tea::runtime::{
    CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Profile, launch,
};
use demlik_tea::{Machine, PlainData, Step, Sub, Tagged, Update};
use std::{
    cell::{Cell, RefCell},
    convert::Infallible,
    rc::Rc,
    sync::Arc,
};
macro_rules! observe {($calls:expr,$call:path $(,$arg:expr)* $(,)?)=>{{let result=$call($($arg),*);$calls.push(stringify!($call));result}};}
struct Note {
    text: String,
}
struct State {
    count: u32,
    log: Vec<Arc<Note>>,
    token: Rc<Cell<u32>>,
}
impl Tagged for State {
    fn tag(&self) -> &str {
        "counting"
    }
}
enum Msg {
    Add { by: u32, token: Rc<Cell<u32>> },
    Note { note: Arc<Note> },
}
impl Tagged for Msg {
    fn tag(&self) -> &str {
        match self {
            Self::Add { .. } => "add",
            Self::Note { .. } => "note",
        }
    }
}
struct Context {
    start: u32,
    token: Rc<Cell<u32>>,
}
enum Cmd {
    Write,
}
impl Tagged for Cmd {
    fn tag(&self) -> &str {
        "write"
    }
}
impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Msg;
    fn settle(self, completion: Msg, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        Ok(vec![completion])
    }
}
#[derive(Default)]
struct Counts {
    init: Cell<u32>,
    update: Cell<u32>,
    subs: Cell<u32>,
    handler: Cell<u32>,
}
struct Backend {
    counts: Rc<Counts>,
    token: Rc<Cell<u32>>,
}
impl Interpreter<Cmd> for Backend {
    type Error = Infallible;
    fn interpret<'a>(
        &'a self,
        _: &'a Cmd,
        _: CommandContext<Msg, Infallible>,
    ) -> Option<CommandWork<'a, Msg, Infallible>> {
        Some(CommandWork::new(async move {
            self.counts.handler.set(self.counts.handler.get() + 1);
            Ok(Msg::Add {
                by: 1,
                token: self.token.clone(),
            })
        }))
    }
}
fn machine(counts: Rc<Counts>) -> Machine<'static, State, Msg, Cmd, Sub, Context> {
    let (initial, updated, subscriptions) = (counts.clone(), counts.clone(), counts);
    let mut row: demlik_tea::core::Row<'static, State, Msg, Cmd> = Default::default();
    type UpdateFn = Rc<dyn Fn(&State, &Msg) -> Step<State, Cmd>>;
    let update: UpdateFn = Rc::new(move |state, msg| {
        updated.update.set(updated.update.get() + 1);
        let mut log = state.log.clone();
        let count = match msg {
            Msg::Add { by, .. } => state.count + by,
            Msg::Note { note } => {
                log.push(note.clone());
                state.count
            }
        };
        Step::new(
            State {
                count,
                log,
                token: state.token.clone(),
            },
            vec![],
        )
    });
    for name in ["add", "note"] {
        let update = update.clone();
        row.insert(name.into(), Box::new(move |state, msg| update(state, msg)));
    }
    Machine {
        init: Box::new(move |loaded, ctx| {
            initial.init.set(initial.init.get() + 1);
            let state = loaded.unwrap_or_else(|| State {
                count: ctx.start,
                log: vec![],
                token: ctx.token.clone(),
            });
            Step::new(
                State {
                    count: state.count + 10,
                    log: state.log,
                    token: state.token,
                },
                vec![Cmd::Write],
            )
        }),
        update: Update::RawReducer(row),
        subscriptions: demlik_tea::core::subscriptions(move |_| {
            subscriptions.subs.set(subscriptions.subs.get() + 1);
            vec![]
        }),
    }
}
fn object<const N: usize>(fields: [(&str, PlainData); N]) -> PlainData {
    PlainData::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}
fn token(value: u32) -> PlainData {
    object([("value", PlainData::Number(f64::from(value)))])
}
fn state_data(state: &State) -> Result<PlainData, &'static str> {
    Ok(object([
        ("type", PlainData::String(state.tag().into())),
        ("count", PlainData::Number(f64::from(state.count))),
        (
            "log",
            PlainData::Array(
                state
                    .log
                    .iter()
                    .map(|note| PlainData::String(note.text.as_str().into()))
                    .collect(),
            ),
        ),
        ("token", token(state.token.get())),
    ]))
}
fn msg_data(msg: &Msg) -> Result<PlainData, &'static str> {
    Ok(match msg {
        Msg::Add { by, token: value } => object([
            ("type", PlainData::String("add".into())),
            ("by", PlainData::Number(f64::from(*by))),
            ("token", token(value.get())),
        ]),
        Msg::Note { note } => object([
            ("type", PlainData::String("note".into())),
            ("text", PlainData::String(note.text.as_str().into())),
        ]),
    })
}
fn field<'a>(value: &'a PlainData, key: &str) -> Result<&'a PlainData, &'static str> {
    match value {
        PlainData::Object(fields) => fields.get(key).ok_or("missing field"),
        _ => Err("expected object"),
    }
}
fn number(value: &PlainData) -> Result<u32, &'static str> {
    match value {
        PlainData::Number(value)
            if value.is_finite()
                && *value >= 0.0
                && value.fract() == 0.0
                && *value <= f64::from(u32::MAX) =>
        {
            Ok(*value as u32)
        }
        _ => Err("expected u32"),
    }
}
fn text(value: &PlainData) -> Result<String, &'static str> {
    match value {
        PlainData::String(value) => value
            .as_utf8()
            .map(str::to_owned)
            .ok_or("expected UTF8 note"),
        _ => Err("expected text"),
    }
}
fn state_from(value: &PlainData) -> Result<State, &'static str> {
    let PlainData::Array(log) = field(value, "log")? else {
        return Err("expected log");
    };
    Ok(State {
        count: number(field(value, "count")?)?,
        log: log
            .iter()
            .map(|value| text(value).map(|text| Arc::new(Note { text })))
            .collect::<Result<Vec<_>, _>>()?,
        token: Rc::new(Cell::new(number(field(field(value, "token")?, "value")?)?)),
    })
}
fn msg_from(value: &PlainData) -> Result<Msg, &'static str> {
    Ok(match text(field(value, "type")?)?.as_str() {
        "add" => Msg::Add {
            by: number(field(value, "by")?)?,
            token: Rc::new(Cell::new(number(field(field(value, "token")?, "value")?)?)),
        },
        "note" => Msg::Note {
            note: Arc::new(Note {
                text: text(field(value, "text")?)?,
            }),
        },
        _ => return Err("unknown message"),
    })
}
fn compare(expected: &State, actual: &State) -> Result<Option<(u32, u32)>, Infallible> {
    Ok((expected.count != actual.count
        || expected.token.get() != actual.token.get()
        || expected
            .log
            .iter()
            .map(|note| &note.text)
            .ne(actual.log.iter().map(|note| &note.text)))
    .then_some((expected.count, actual.count)))
}
async fn scenario(profile: Profile, capture_steps: bool, sampled: bool) {
    let counts = Rc::new(Counts::default());
    let shared = Rc::new(Cell::new(7));
    let options: Options<State, Msg, Infallible, Infallible> = Options::new(profile);
    let rt = launch(
        machine(counts.clone()),
        Context {
            start: 4,
            token: shared.clone(),
        },
        Backend {
            counts: counts.clone(),
            token: shared.clone(),
        },
        NoSubscriptions::new(),
        options,
    );
    let rng_calls = Rc::new(Cell::new(0));
    let rng = rng_calls.clone();
    let mut public_calls = vec![];
    let rec = if sampled {
        observe!(
            public_calls,
            demlik_tea::persistence::recorder::recorder_with,
            &rt,
            RecorderOptions {
                sample_rate: Some(0.5),
                capture_steps
            },
            move || {
                let i = rng.get();
                rng.set(i + 1);
                [0.1, 0.9, 0.1, 0.9][i]
            },
            |_| StateKind::Value,
        )
    } else {
        observe!(
            public_calls,
            demlik_tea::persistence::recorder::recorder,
            &rt,
            RecorderOptions {
                sample_rate: None,
                capture_steps
            },
        )
    };
    let received = Rc::new(RefCell::new(vec![]));
    let received_in = received.clone();
    let off = rt.observe_retained(move |msg, state| {
        received_in
            .borrow_mut()
            .push((Arc::clone(msg), Arc::clone(state)))
    });
    rt.ready().await.unwrap();
    rt.idle().await.unwrap();
    rt.dispatch(Msg::Add {
        by: 2,
        token: shared.clone(),
    })
    .await
    .unwrap();
    rt.dispatch(Msg::Note {
        note: Arc::new(Note {
            text: "opaque note".into(),
        }),
    })
    .await
    .unwrap();
    rt.dispatch(Msg::Add {
        by: 3,
        token: shared.clone(),
    })
    .await
    .unwrap();
    rt.idle().await.unwrap();
    let trace = observe!(
        public_calls,
        demlik_tea::persistence::recorder::Recorder::dump,
        &rec
    )
    .unwrap();
    assert_eq!(trace.loaded.as_ref().unwrap().count, 14);
    assert_eq!(trace.final_state.count, 20);
    assert!(Arc::ptr_eq(&trace.final_state, &rt.get_state().unwrap()));
    assert_eq!(received.borrow().len(), 4);
    let kept: Vec<usize> = if sampled {
        vec![0, 2]
    } else {
        vec![0, 1, 2, 3]
    };
    for (i, msg) in trace.msgs.iter().enumerate() {
        assert!(Arc::ptr_eq(msg, &received.borrow()[kept[i]].0));
        if let Msg::Add { token, .. } = msg.as_ref() {
            assert!(Rc::ptr_eq(token, &shared));
        }
    }
    assert_eq!(trace.steps.is_some(), capture_steps);
    assert_eq!(rng_calls.get(), if sampled { 4 } else { 0 });
    let jsonl = observe!(
        public_calls,
        demlik_tea::persistence::recorder::Recorder::to_jsonl_with,
        &rec,
        state_data,
        msg_data
    )
    .unwrap();
    let parsed = observe!(
        public_calls,
        demlik_tea::persistence::recorder::parse_jsonl_with,
        &jsonl,
        state_from,
        msg_from
    )
    .unwrap();
    assert_eq!(
        parsed.final_state.count,
        if sampled && capture_steps { 17 } else { 20 }
    );
    let init_before = counts.init.get();
    let effects_before = counts.handler.get();
    let subs_before = counts.subs.get();
    let update_before = counts.update.get();
    let cold = observe!(
        public_calls,
        demlik_tea::persistence::trace_replay::replay_trace_with,
        &machine(counts.clone()),
        &parsed,
        compare
    )
    .unwrap();
    assert_eq!(cold.matches, !sampled);
    assert_eq!(cold.actual.count, if sampled { 15 } else { 20 });
    assert!(Arc::ptr_eq(&cold.expected, &parsed.final_state));
    assert_eq!(counts.init.get(), init_before);
    assert_eq!(counts.handler.get(), effects_before);
    let selectors_unchanged = counts.subs.get() == subs_before;
    assert!(selectors_unchanged);
    assert_eq!(counts.update.get() - update_before, trace.msgs.len() as u32);
    assert_eq!(init_before, 1);
    assert_eq!(effects_before, 1);
    assert_eq!(trace.final_state.log[0].text, "opaque note");
    observe!(
        public_calls,
        demlik_tea::persistence::recorder::Recorder::stop,
        &rec
    );
    rec.stop();
    rt.dispatch(Msg::Add {
        by: 100,
        token: shared.clone(),
    })
    .await
    .unwrap();
    assert!(Arc::ptr_eq(
        &rec.dump().unwrap().final_state,
        &trace.final_state
    ));
    assert_eq!(rec.dump().unwrap().msgs.len(), kept.len());
    off();
    rt.stop().await;
    shared.set(9);
    assert_eq!(trace.final_state.token.get(), 9);
    assert_eq!(trace.loaded.as_ref().unwrap().token.get(), 9);
    assert_eq!(parsed.final_state.token.get(), 7);
    assert!(rt.reports().is_empty());
    println!(
        "TRACE_RECORDER_RUNTIME:{}",
        serde_json::json!({"profile":format!("{profile:?}"),"captureSteps":capture_steps,"sampled":sampled,"anchor":trace.loaded.as_ref().unwrap().count,"recorded":trace.msgs.len(),"dumpFinal":trace.final_state.count,"wireFinal":parsed.final_state.count,"actual":cold.actual.count,"matches":cold.matches,"initCalls":init_before,"handlerCalls":effects_before,"selectorCallsUnchanged":selectors_unchanged,"reports":rt.reports().len(),"observedCalls":public_calls})
    );
}
#[tokio::test(flavor = "current_thread")]
async fn both_actual_runtime_profiles_record_jsonl_parse_and_replay_opaque_values_without_init_or_effects()
 {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                for capture in [false, true] {
                    for sampled in [false, true] {
                        scenario(profile, capture, sampled).await;
                    }
                }
            }
        })
        .await;
}
