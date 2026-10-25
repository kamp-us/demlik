use demlik_tea::flow::{batch_window as batch, fan_out as fan};
use demlik_tea::{PlainData, Step, Tagged, data::JsText, ports::define_port};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    io::{self, BufRead},
    rc::Rc,
};
#[path = "../paginate_queue/wire.rs"]
mod wire;
use wire::{Number, data, normalized, number, text};
type Calls = RefCell<Vec<&'static str>>;
macro_rules! observe { ($calls:expr, $function:path $(, $arg:expr)* $(,)?) => {{
    let value = $function($($arg),*); $calls.borrow_mut().push(stringify!($function)); value
}}; }

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ItemInput {
    id: JsText,
    value: Value,
}
struct Item {
    id: JsText,
    value: PlainData,
}
impl From<ItemInput> for Rc<Item> {
    fn from(item: ItemInput) -> Self {
        Rc::new(Item {
            id: item.id,
            value: data(&item.value),
        })
    }
}
fn item(item: &Item) -> Value {
    json!({"id":text(&item.id),"value":normalized(&item.value)})
}
enum Command {
    Launch(Rc<Item>),
    Join(Vec<Rc<PlainData>>),
    Flush(Rc<Vec<Rc<Item>>>),
}
impl Tagged for Command {
    fn tag(&self) -> &str {
        match self {
            Self::Launch(_) => "launch",
            Self::Join(_) => "join",
            Self::Flush(_) => "flush",
        }
    }
}
fn command(command: &Command) -> Value {
    match command {
        Command::Launch(input) => json!({"type":"launch","item":item(input)}),
        Command::Join(results) => {
            json!({"type":"join","results":results.iter().map(|value|normalized(value)).collect::<Vec<_>>()})
        }
        Command::Flush(items) => {
            json!({"type":"flush","items":items.iter().map(|value|item(value)).collect::<Vec<_>>()})
        }
    }
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Script {
    FanOut {
        concurrency: Number,
        join: bool,
        bare_init: bool,
        actions: Vec<FanAction>,
    },
    BatchWindow {
        max_items: Number,
        max_ms: Number,
        bound: bool,
        id: Option<JsText>,
        initial: Option<WindowInput>,
        actions: Vec<BatchAction>,
    },
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum FanAction {
    Scatter { items: Vec<ItemInput> },
    Ok { id: JsText, result: Value },
    Err { id: JsText, error: Value },
    Emit,
    Reset,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WindowInput {
    buffer: Vec<ItemInput>,
    opened_at: Option<Number>,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum BatchAction {
    Add { item: ItemInput, at: Number },
    Window { at: Number },
    Expired { id: JsText, at: Number },
    Reset,
}

fn fan_state(state: &fan::FanOutState<Item, PlainData>) -> Value {
    json!({"pending":state.pending.iter().map(|value|item(value)).collect::<Vec<_>>(),
      "running":state.running.iter().map(|value|item(value)).collect::<Vec<_>>(),
      "done":state.done.iter().map(|value|json!({"item":item(&value.item),"result":normalized(&value.result)})).collect::<Vec<_>>(),
      "failed":state.failed.iter().map(|value|json!({"item":item(&value.item),"error":normalized(&value.error)})).collect::<Vec<_>>(),
      "items":state.items.iter().map(|value|{let mut record=json!({"id":text(&value.id),"input":item(&value.input),"enqueuedAt":value.enqueued_at.number().map(number),"status":wire::snapshot(&value.status)});if let Some(at)=value.started_at.value(){record["startedAt"]=at.number().map_or(Value::Null,number);}record}).collect::<Vec<_>>(),
      "waveDoneFrom":number(state.wave_done_from),"waveFailedFrom":number(state.wave_failed_from),"joined":state.joined})
}
fn fan_row(
    state: &fan::FanOutState<Item, PlainData>,
    commands: &[Command],
    same: Option<bool>,
    unchanged: bool,
    emissions: &[Value],
    calls: &Calls,
) -> Value {
    json!({"state":fan_state(state),"commands":commands.iter().map(command).collect::<Vec<_>>(),"sameState":same,"priorStateUnchanged":unchanged,
        "complete":observe!(calls,fan::is_complete,state),"emissions":emissions})
}
static PORT_SEQUENCE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
fn run_fan(
    concurrency: f64,
    join: bool,
    bare_init: bool,
    actions: Vec<FanAction>,
    calls: &Calls,
) -> Value {
    let config = observe!(
        calls,
        fan::FanOutConfig::new,
        concurrency,
        |value: &Item| value.id.clone(),
        |value: &Rc<Item>| Command::Launch(Rc::clone(value))
    );
    let mut knob = observe!(calls, fan::create_fan_out, config);
    if join {
        knob = observe!(calls, fan::FanOut::with_join, knob, |results: &[Rc<
            PlainData,
        >]| {
            Command::Join(results.to_vec())
        });
    }
    let mut state = if bare_init {
        observe!(calls, fan::init_fan_out)
    } else {
        observe!(calls, fan::FanOut::init, &knob)
    };
    let port = observe!(
        calls,
        define_port,
        format!(
            "flow.driver.complete.{}",
            PORT_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        )
    )
    .unwrap();
    let completion = observe!(
        calls,
        fan::FanOut::completion,
        &knob,
        fan::FanOutPorts { complete: port }
    );
    let mut emissions = vec![];
    let mut rows = vec![fan_row(&state, &[], None, true, &emissions, calls)];
    for action in actions {
        let before = fan_state(&state);
        let step = match action {
            FanAction::Scatter { items } => observe!(
                calls,
                fan::FanOut::scatter,
                &knob,
                &state,
                items.into_iter().map(Rc::<Item>::from)
            ),
            FanAction::Ok { id, result } => observe!(
                calls,
                fan::FanOut::item_ok,
                &knob,
                &state,
                &id,
                Rc::new(data(&result))
            ),
            FanAction::Err { id, error } => observe!(
                calls,
                fan::FanOut::item_err,
                &knob,
                &state,
                &id,
                Rc::new(data(&error))
            ),
            FanAction::Emit => {
                observe!(
                    calls,
                    fan::FanOutCompletion::emit_on_complete,
                    &completion,
                    |_, values: Vec<Rc<PlainData>>| emissions.push(json!(
                        values
                            .iter()
                            .map(|value| normalized(value))
                            .collect::<Vec<_>>()
                    )),
                    &state
                );
                Step::new(Rc::clone(&state), vec![])
            }
            FanAction::Reset => Step::new(observe!(calls, fan::FanOut::init, &knob), vec![]),
        };
        let unchanged = before == fan_state(&state);
        let same = Rc::ptr_eq(&state, &step.state);
        state = step.state;
        assert_eq!(
            observe!(calls, fan::FanOut::is_complete, &knob, &state),
            fan::is_complete(&state)
        );
        rows.push(fan_row(
            &state,
            &step.commands,
            Some(same),
            unchanged,
            &emissions,
            calls,
        ));
    }
    json!(rows)
}
fn window_state(state: &batch::BatchWindow<Item>) -> Value {
    json!({"buffer":state.buffer.iter().map(|value|item(value)).collect::<Vec<_>>(),"openedAt":state.opened_at.map(number)})
}
fn window_row(
    state: &batch::BatchWindow<Item>,
    commands: &[Command],
    same: Option<bool>,
    unchanged: bool,
    event: Option<Value>,
    timer: Option<demlik_tea::TimerDeps<batch::BatchWindowExpired>>,
    deadlines: Vec<batch::BatchWindowSub>,
) -> Value {
    json!({"state":window_state(state),"commands":commands.iter().map(command).collect::<Vec<_>>(),"sameState":same,"priorStateUnchanged":unchanged,"event":event,
      "timer":timer.map(|timer|json!({"ms":number(timer.ms),"msg":{"type":timer.msg.kind,"id":text(&timer.msg.id),"atMs":wire::snapshot(&timer.msg.at_ms)}})),
      "deadlines":deadlines.iter().map(|deadline|json!({"id":text(&deadline.id),"type":"deadline","atMs":wire::snapshot(&deadline.at_ms)})).collect::<Vec<_>>()})
}
fn run_window(
    max_items: f64,
    max_ms: f64,
    bound: bool,
    id: Option<JsText>,
    initial: Option<WindowInput>,
    actions: Vec<BatchAction>,
    calls: &Calls,
) -> Value {
    let flush = |items: &Rc<Vec<Rc<Item>>>| Command::Flush(Rc::clone(items));
    let config = observe!(
        calls,
        batch::BatchWindowConfig::new,
        max_items,
        max_ms,
        flush
    );
    let knob = observe!(
        calls,
        batch::create_batch_window,
        observe!(
            calls,
            batch::BatchWindowConfig::new,
            max_items,
            max_ms,
            flush
        )
    );
    let init = || {
        if bound {
            observe!(calls, batch::BatchWindowKnob::init, &knob)
        } else {
            observe!(calls, batch::init_batch_window)
        }
    };
    let selectors = |state: &batch::BatchWindow<Item>| {
        if bound {
            (
                observe!(
                    calls,
                    batch::BatchWindowKnob::timer,
                    &knob,
                    state,
                    id.as_ref()
                ),
                observe!(
                    calls,
                    batch::BatchWindowKnob::subs,
                    &knob,
                    state,
                    id.as_ref()
                ),
            )
        } else {
            (
                observe!(calls, batch::timer_for, &config, state, id.as_ref()),
                observe!(calls, batch::subs_for, &config, state, id.as_ref()),
            )
        }
    };
    let mut state = initial.map_or_else(init, |initial| {
        Rc::new(batch::BatchWindow {
            buffer: Rc::new(initial.buffer.into_iter().map(Rc::from).collect()),
            opened_at: initial.opened_at.map(Number::value),
        })
    });
    let (timer, deadlines) = selectors(&state);
    let mut rows = vec![window_row(&state, &[], None, true, None, timer, deadlines)];
    for action in actions {
        let before = window_state(&state);
        let mut event = None;
        let step = match action {
            BatchAction::Add { item, at } => {
                if bound {
                    observe!(
                        calls,
                        batch::BatchWindowKnob::add,
                        &knob,
                        &state,
                        Rc::from(item),
                        at.value()
                    )
                } else {
                    observe!(
                        calls,
                        batch::add_item,
                        &config,
                        &state,
                        Rc::from(item),
                        at.value()
                    )
                }
            }
            BatchAction::Window { at } => {
                if bound {
                    observe!(
                        calls,
                        batch::BatchWindowKnob::on_window,
                        &knob,
                        &state,
                        at.value()
                    )
                } else {
                    observe!(calls, batch::on_window, &config, &state, at.value())
                }
            }
            BatchAction::Expired { id, at } => {
                let msg = observe!(calls, batch::batch_window_expired, id, at.value());
                event = Some(
                    json!({"type":msg.kind,"id":text(&msg.id),"atMs":wire::snapshot(&msg.at_ms)}),
                );
                Step::new(Rc::clone(&state), vec![])
            }
            BatchAction::Reset => Step::new(init(), vec![]),
        };
        let unchanged = before == window_state(&state);
        let same = Rc::ptr_eq(&state, &step.state);
        state = step.state;
        let (timer, deadlines) = selectors(&state);
        rows.push(window_row(
            &state,
            &step.commands,
            Some(same),
            unchanged,
            event,
            timer,
            deadlines,
        ));
    }
    json!(rows)
}
fn execute(script: Script) -> Value {
    let calls = Calls::new(vec![]);
    let comparison = match script {
        Script::FanOut {
            concurrency,
            join,
            bare_init,
            actions,
        } => run_fan(concurrency.value(), join, bare_init, actions, &calls),
        Script::BatchWindow {
            max_items,
            max_ms,
            bound,
            id,
            initial,
            actions,
        } => run_window(
            max_items.value(),
            max_ms.value(),
            bound,
            id,
            initial,
            actions,
            &calls,
        ),
    };
    json!({"comparison":comparison,"observedRustCalls":*calls.borrow()})
}
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let script: Script = serde_json::from_str(&line).expect("validated flow script");
        println!("{}", execute(script));
    }
}
