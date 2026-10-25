use super::wire::{Number, data, snapshot};
use demlik_tea::{PlainData, data::JsText, work_queue::*};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{cell::RefCell, rc::Rc};
pub type Payload = RefCell<PlainData>;

pub fn text(value: &Value) -> JsText {
    string(&data(value))
}
pub fn string(value: &PlainData) -> JsText {
    match value {
        PlainData::String(v) => v.clone(),
        PlainData::Null => "null".into(),
        PlainData::Undefined => "undefined".into(),
        PlainData::Bool(v) => v.to_string().into(),
        PlainData::Number(_) => demlik_tea::structural_hash(value).into(),
        PlainData::Object(_) => "[object Object]".into(),
        PlainData::Array(values) => {
            let mut units = Vec::new();
            for (i, value) in values.iter().enumerate() {
                if i != 0 {
                    units.push(44);
                }
                if !matches!(value, PlainData::Null | PlainData::Undefined) {
                    units.extend_from_slice(string(value).as_units());
                }
            }
            JsText::from_units(units)
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Action {
    Enqueue {
        input: Value,
        id: Value,
        at: Option<Number>,
    },
    MutateList {
        input: Value,
        id: Value,
        at: Option<Number>,
    },
    Claim {
        at: Option<Number>,
    },
    Done {
        id: Value,
    },
    Remove {
        id: Value,
    },
    Cancel {
        id: Value,
        at: Option<Number>,
    },
    Retry {
        id: Value,
    },
    Fail {
        id: Value,
        error: Value,
        at: Option<Number>,
    },
    Bind {
        id: Value,
        value: Value,
    },
    Patch {
        id: Value,
        #[serde(default)]
        same: bool,
        status: Option<QueueItemStatus>,
    },
    MutateInput {
        index: usize,
        key: Value,
        value: Value,
    },
    Reset,
    RoundTrip,
    List,
}
pub fn seed(raw: Option<&str>) -> Result<Queue<Payload>, String> {
    raw.map_or_else(
        || Ok(Queue::new()),
        |raw| serde_json::from_str(raw).map_err(|e| e.to_string()),
    )
}
pub fn patch(queue: &Queue<Payload>, action: &Action) -> QueueChange<Payload> {
    match action {
        Action::Fail { id, error, at } => patch_item_op(queue, text(id), |item| {
            Rc::new(
                item.with_status(QueueItemStatus::Failed)
                    .with_finished_at(QueueField::Value(at.map_or(0.0, Number::value).into()))
                    .with_error(QueueField::Value(text(error))),
            )
        }),
        Action::Cancel { id, at } => patch_item_op(queue, text(id), |item| {
            Rc::new(
                item.with_status(QueueItemStatus::Cancelled)
                    .with_finished_at(QueueField::Value(at.map_or(0.0, Number::value).into())),
            )
        }),
        Action::Bind { id, value } => patch_item_op(queue, text(id), |item| {
            Rc::new(item.with_output(QueueField::Value(text(value))))
        }),
        Action::Retry { id } => patch_item_op(queue, text(id), |item| Rc::new(item.retried())),
        _ => unreachable!("queue patch action"),
    }
}
pub fn execute(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        seed_raw: Option<String>,
        #[serde(default)]
        adapter: bool,
        actions: Vec<Action>,
    }
    let input: Input = serde_json::from_value(input).map_err(|e| e.to_string())?;
    let verbs = observe!(calls, demlik_tea::work_queue::queue_adapter);
    let mut state = seed(input.seed_raw.as_deref())?;
    let initial = snapshot(&state);
    let mut history = vec![state.clone()];
    let mut observations = Vec::new();
    for action in input.actions {
        let old = state.clone();
        let mut changed = None;
        let mut item = None;
        let mut json_text = None;
        let op = match action {
            Action::Enqueue {
                input: value,
                id,
                at,
            } => {
                let result = if input.adapter {
                    observe!(
                        calls,
                        demlik_tea::work_queue::QueueAdapter::enqueue,
                        &verbs,
                        &state,
                        Rc::new(RefCell::new(data(&value))),
                        at.map_or(0.0, Number::value),
                        text(&id)
                    )
                } else {
                    observe!(
                        calls,
                        demlik_tea::work_queue::enqueue_op,
                        &state,
                        Rc::new(RefCell::new(data(&value))),
                        at.map_or(0.0, Number::value),
                        text(&id)
                    )
                };
                state = result.next;
                item = Some(result.item);
                "enqueue"
            }
            Action::MutateList { input, id, at } => {
                let item = observe!(
                    calls,
                    demlik_tea::work_queue::QueueItem::new,
                    Rc::new(RefCell::new(data(&input))),
                    at.map_or(0.0, Number::value),
                    text(&id)
                );
                state.items_mut().push(Rc::new(item));
                "mutateList"
            }
            Action::Claim { at } => {
                let result = if input.adapter {
                    observe!(
                        calls,
                        demlik_tea::work_queue::QueueAdapter::claim,
                        &verbs,
                        &state,
                        at.map_or(0.0, Number::value)
                    )
                } else {
                    observe!(
                        calls,
                        demlik_tea::work_queue::claim_next_op,
                        &state,
                        at.map_or(0.0, Number::value)
                    )
                };
                if let Some(result) = result {
                    state = result.next;
                    item = Some(result.claimed);
                }
                "claim"
            }
            Action::Done { ref id } | Action::Remove { ref id } => {
                let removing = matches!(action, Action::Remove { .. });
                let result = if removing {
                    observe!(calls, demlik_tea::work_queue::remove_op, &state, text(id))
                } else if input.adapter {
                    observe!(
                        calls,
                        demlik_tea::work_queue::QueueAdapter::mark_done,
                        &verbs,
                        &state,
                        text(id)
                    )
                } else {
                    observe!(
                        calls,
                        demlik_tea::work_queue::mark_done_op,
                        &state,
                        text(id)
                    )
                };
                state = result.next;
                changed = Some(result.changed);
                if removing { "remove" } else { "done" }
            }
            Action::Patch { id, same, status } => {
                let patch = |item: &Rc<QueueItem<Payload>>| {
                    if same {
                        item.clone()
                    } else {
                        Rc::new(item.with_status(status.unwrap_or(item.status)))
                    }
                };
                let result = if input.adapter {
                    observe!(
                        calls,
                        demlik_tea::work_queue::QueueAdapter::patch,
                        &verbs,
                        &state,
                        text(&id),
                        patch
                    )
                } else {
                    observe!(
                        calls,
                        demlik_tea::work_queue::patch_item_op,
                        &state,
                        text(&id),
                        patch
                    )
                };
                state = result.next;
                changed = Some(result.changed);
                "patch"
            }
            Action::Reset => {
                let result = observe!(calls, demlik_tea::work_queue::reset_running_op, &state);
                state = result.next;
                changed = Some(result.changed);
                "reset"
            }
            Action::Fail { .. }
            | Action::Cancel { .. }
            | Action::Retry { .. }
            | Action::Bind { .. } => {
                let result = patch(&state, &action);
                state = result.next;
                changed = Some(result.changed);
                match action {
                    Action::Fail { .. } => "fail",
                    Action::Cancel { .. } => "cancel",
                    Action::Retry { .. } => "retry",
                    _ => "bind",
                }
            }
            Action::MutateInput { index, key, value } => {
                if let Some(item) = state.get(index)
                    && let PlainData::Object(fields) = &mut *item.input.borrow_mut()
                {
                    fields.insert(text(&key), data(&value));
                }
                "mutateInput"
            }
            Action::RoundTrip => {
                let raw = demlik_tea::data::plain_data(&state).map_err(|e| e.to_string())?;
                let text = demlik_tea::data::stringify_json(&raw).ok_or("undefined queue")?;
                state = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                json_text = Some(text);
                "roundTrip"
            }
            Action::List => "list",
        };
        let old_items: Vec<_> = state
            .iter()
            .map(|item| {
                old.iter()
                    .position(|old| Rc::ptr_eq(&old, &item))
                    .map_or(-1, |i| i as i64)
            })
            .collect();
        let item_index = item.as_ref().map(|item| {
            state
                .iter()
                .position(|value| Rc::ptr_eq(&value, item))
                .map_or(-1, |i| i as i64)
        });
        let mut observation = json!({"op":op,"state":snapshot(&state),"same":old.ptr_eq(&state),"oldItems":old_items,"changed":changed,"item":item.as_ref().map(snapshot),"itemIndex":item_index});
        if let Some(text) = json_text {
            observation["json"] = json!(text);
        }
        observations.push(observation);
        history.push(state.clone());
    }
    Ok(json!({"initial":initial,"observations":observations,"historyAtEnd":snapshot(&history)}))
}
