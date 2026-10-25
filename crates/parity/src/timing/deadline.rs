use super::{
    Number,
    clock::{Clock, panic_error, timer_error},
    data, snapshot,
};
use demlik_tea::{PlainData, resilience::deadline::*, timing::TimerError};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    panic::{AssertUnwindSafe, catch_unwind},
    rc::Rc,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Spec {
    id: Value,
    at_ms: Number,
    name: Option<String>,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Action {
    Advance { to: Number },
    Cancel,
    Fire { index: usize },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    #[serde(default)]
    list: Vec<Spec>,
    #[serde(default)]
    queries: Vec<Number>,
    #[serde(default)]
    now: Option<Number>,
    #[serde(default)]
    mode: Option<String>,
    fail_arm_at: Option<u64>,
    fail_cancel_at: Option<usize>,
    #[serde(default)]
    actions: Vec<Action>,
}
type Cleanup = Box<dyn Fn() -> Result<(), TimerError>>;
fn observed_cleanup<C: Cancel<Error = TimerError> + 'static>(
    cleanup: DeadlineSubscription<C>,
    calls: Rc<RefCell<Vec<&'static str>>>,
) -> Cleanup {
    Box::new(move || {
        let mut observed = Vec::new();
        let result = observe!(
            &mut observed,
            demlik_tea::resilience::deadline::DeadlineSubscription::cancel,
            &cleanup
        );
        calls.borrow_mut().extend(observed);
        result
    })
}
struct Parked {
    active: Rc<Cell<bool>>,
    msg: DeadlineExceeded,
    dispatch: Dispatch<DeadlineExceeded>,
}
pub fn execute(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let mut list = Vec::new();
    for spec in input.list {
        let PlainData::String(id) = data(&spec.id) else {
            return Err("deadline id must be text".into());
        };
        let mut deadline = observe!(
            calls,
            demlik_tea::resilience::deadline::deadline_sub,
            id,
            spec.at_ms.value()
        );
        if let Some(name) = spec.name {
            deadline = observe!(
                calls,
                demlik_tea::resilience::deadline::Deadline::with_options,
                deadline,
                DeadlineOptions { name: Some(name) }
            );
        }
        list.push(deadline);
    }
    let messages = list
        .iter()
        .map(|deadline| {
            observe!(
                calls,
                demlik_tea::resilience::deadline::deadline_exceeded,
                &deadline.id,
                deadline.at_ms,
                deadline.name.as_deref()
            )
        })
        .collect::<Vec<_>>();
    let tags = list
        .iter()
        .map(|deadline| {
            observe!(
                calls,
                demlik_tea::resilience::deadline::deadline_msg_type,
                deadline.name.as_deref()
            )
        })
        .collect::<Vec<_>>();
    let deps = observe!(calls, demlik_tea::resilience::deadline::deadlines, &list);
    let deps_same = deps.is_some_and(|deps| std::ptr::eq(deps, list.as_slice()));
    let project = observe!(
        calls,
        demlik_tea::resilience::deadline::deadlines_sub,
        |state: &Vec<Deadline>| state.clone()
    );
    let projection = project(&list).map_err(|error| error.to_string())?;
    let queries = input
        .queries
        .into_iter()
        .map(|now| {
            snapshot(&observe!(
                calls,
                demlik_tea::resilience::deadline::next_timer,
                &list,
                now.value()
            ))
        })
        .collect::<Vec<_>>();
    let mode = input.mode.unwrap_or_else(|| "none".into());
    let clock = Rc::new(Clock::new(
        input.now.map(Number::value).unwrap_or(0.0),
        input.fail_arm_at,
    ));
    let dispatched = Rc::new(RefCell::new(Vec::new()));
    let arms = Rc::new(RefCell::new(Vec::new()));
    let cancels = Rc::new(RefCell::new(Vec::new()));
    let parked = Rc::new(RefCell::new(Vec::<Parked>::new()));
    let dispatch: Dispatch<DeadlineExceeded> = {
        let clock = clock.clone();
        let dispatched = dispatched.clone();
        Rc::new(move |msg| {
            dispatched
                .borrow_mut()
                .push(json!({"at":super::number(clock.now.get()),"msg":snapshot(&msg)}))
        })
    };
    let sub = observe!(calls, demlik_tea::Sub::new, "deadline", list.clone())
        .map_err(|error| error.to_string())?;
    let mut cleanup: Option<Cleanup> = None;
    let cleanup_calls = Rc::new(RefCell::new(Vec::new()));
    let setup: Result<Option<Cleanup>, TimerError> = match mode.as_str() {
        "none" => Ok(None),
        "default" => observe!(
            calls,
            demlik_tea::resilience::deadline::subscribe_deadline,
            &sub,
            clock.clone(),
            dispatch.clone()
        )
        .map(|cleanup| Some(observed_cleanup(cleanup, cleanup_calls.clone()))),
        "seam" => {
            let arm = observe!(
                calls,
                demlik_tea::resilience::deadline::set_timeout_arm_timer,
                clock.clone()
            );
            observe!(
                calls,
                demlik_tea::resilience::deadline::subscribe_with,
                arm,
                &sub,
                dispatch.clone()
            )
            .map(|cleanup| Some(observed_cleanup(cleanup, cleanup_calls.clone())))
        }
        "record" | "inline" => {
            let arms_count = Cell::new(0);
            let cancel_count = Rc::new(Cell::new(0));
            let fail_cancel = input.fail_cancel_at;
            let fail_arm = input.fail_arm_at;
            let inline = mode == "inline";
            let arm = {
                let arms = arms.clone();
                let cancels = cancels.clone();
                let parked = parked.clone();
                let clock = clock.clone();
                move |id: &demlik_tea::data::JsText,
                      at_ms,
                      msg: DeadlineExceeded,
                      dispatch: Dispatch<DeadlineExceeded>|
                      -> Result<Cleanup, TimerError> {
                    arms_count.set(arms_count.get() + 1);
                    arms.borrow_mut().push(json!({"id":super::text(id),"atMs":snapshot(&at_ms),"msg":snapshot(&msg),"at":super::number(clock.now.get())}));
                    if fail_arm == Some(arms_count.get()) {
                        return Err(TimerError::new(format!("arm failed {}", arms_count.get())));
                    }
                    let active = Rc::new(Cell::new(true));
                    if inline {
                        dispatch(msg.clone());
                    }
                    parked.borrow_mut().push(Parked {
                        active: active.clone(),
                        msg,
                        dispatch,
                    });
                    let cancels = cancels.clone();
                    let cancel_count = cancel_count.clone();
                    let id = id.clone();
                    Ok(Box::new(move || {
                        cancel_count.set(cancel_count.get() + 1);
                        cancels.borrow_mut().push(super::text(&id));
                        if fail_cancel == Some(cancel_count.get()) {
                            return Err(TimerError::new(format!(
                                "cancel failed {}",
                                cancel_count.get()
                            )));
                        }
                        active.set(false);
                        Ok(())
                    }))
                }
            };
            observe!(
                calls,
                demlik_tea::resilience::deadline::subscribe_with,
                arm,
                &sub,
                dispatch.clone()
            )
            .map(|cleanup| Some(observed_cleanup(cleanup, cleanup_calls.clone())))
        }
        _ => return Err("unknown deadline runner mode".into()),
    };
    match setup {
        Ok(value) => cleanup = value,
        Err(error) => clock.error("subscribe", timer_error(&error)),
    }
    for action in input.actions {
        let result = catch_unwind(AssertUnwindSafe(|| match action {
            Action::Advance { to } => clock.advance(to.value()).map_err(TimerError::new),
            Action::Cancel => cleanup.as_ref().map_or(Ok(()), |cancel| cancel()),
            Action::Fire { index } => {
                let parked = parked.borrow();
                if let Some(parked) = parked.get(index)
                    && parked.active.get()
                {
                    (parked.dispatch)(parked.msg.clone());
                }
                Ok(())
            }
        }));
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => clock.error("action", timer_error(&error)),
            Err(payload) => clock.error("action", panic_error(payload.as_ref())),
        }
    }
    calls.extend(cleanup_calls.borrow().iter().copied());
    Ok(
        json!({"declarations":snapshot(&list),"messages":snapshot(&messages),"tags":tags,"depsSame":deps_same,"projection":projection.as_ref().map(snapshot),"queries":queries,"arms":*arms.borrow(),"cancels":*cancels.borrow(),"dispatches":*dispatched.borrow(),"timers":*clock.events.borrow(),"errors":*clock.errors.borrow(),"active":clock.active()}),
    )
}
