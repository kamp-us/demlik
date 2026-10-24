use super::{
    Number,
    clock::{Clock, panic_error, timer_error},
    data, normalized,
};
use demlik_tea::{
    PlainData,
    timing::{Debounced, Edges, Throttled, TimerError},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    panic::{AssertUnwindSafe, catch_unwind},
    rc::Rc,
};

#[derive(Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Action {
    Invoke { args: Vec<Value> },
    Cancel,
    Flush,
    Advance { to: Number },
    Throw { value: Value },
}
#[derive(Deserialize)]
struct Reaction {
    when: usize,
    actions: Vec<Action>,
}
#[derive(Deserialize, Default)]
struct Options {
    leading: Option<bool>,
    trailing: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    kind: String,
    ms: Number,
    #[serde(default)]
    now: Option<Number>,
    #[serde(default)]
    options: Options,
    fail_arm_at: Option<u64>,
    #[serde(default)]
    reactions: Vec<Reaction>,
    actions: Vec<Action>,
}
enum Wrapper {
    Debounce(Debounced<Vec<PlainData>, Clock>),
    Throttle(Throttled<Vec<PlainData>, Clock>),
}
impl Wrapper {
    fn invoke(
        &self,
        args: Vec<PlainData>,
        calls: &mut Vec<&'static str>,
    ) -> Result<(), TimerError> {
        match self {
            Self::Debounce(wrapper) => {
                observe!(calls, demlik_tea::timing::Debounced::invoke, wrapper, args)
            }
            Self::Throttle(wrapper) => {
                observe!(calls, demlik_tea::timing::Throttled::invoke, wrapper, args)
            }
        }
    }
    fn cancel(&self, calls: &mut Vec<&'static str>) {
        match self {
            Self::Debounce(wrapper) => {
                observe!(calls, demlik_tea::timing::Debounced::cancel, wrapper)
            }
            Self::Throttle(wrapper) => {
                observe!(calls, demlik_tea::timing::Throttled::cancel, wrapper)
            }
        }
    }
    fn flush(&self, calls: &mut Vec<&'static str>) {
        match self {
            Self::Debounce(wrapper) => {
                observe!(calls, demlik_tea::timing::Debounced::flush, wrapper)
            }
            Self::Throttle(wrapper) => {
                observe!(calls, demlik_tea::timing::Throttled::flush, wrapper)
            }
        }
    }
}
fn action(
    wrapper: &Wrapper,
    clock: &Clock,
    action: &Action,
    calls: &mut Vec<&'static str>,
) -> Result<(), TimerError> {
    match action {
        Action::Invoke { args } => wrapper.invoke(args.iter().map(data).collect(), calls),
        Action::Cancel => {
            wrapper.cancel(calls);
            Ok(())
        }
        Action::Flush => {
            wrapper.flush(calls);
            Ok(())
        }
        Action::Advance { to } => clock.advance(to.value()).map_err(TimerError::new),
        Action::Throw { value } => std::panic::panic_any(value.clone()),
    }
}
pub fn execute(input: Value, calls: &mut Vec<&'static str>) -> Result<Value, String> {
    let input: Input = serde_json::from_value(input).map_err(|error| error.to_string())?;
    let clock = Rc::new(Clock::new(
        input.now.map(Number::value).unwrap_or(0.0),
        input.fail_arm_at,
    ));
    let output = Rc::new(RefCell::new(Vec::new()));
    let holder: Rc<RefCell<Option<Wrapper>>> = Rc::new(RefCell::new(None));
    let nested_calls = Rc::new(RefCell::new(Vec::new()));
    let fire = Cell::new(0);
    let callback = {
        let clock = clock.clone();
        let output = output.clone();
        let holder = Rc::downgrade(&holder);
        let nested_calls = nested_calls.clone();
        move |args: Vec<PlainData>| {
            fire.set(fire.get() + 1);
            output.borrow_mut().push(json!({"at":super::number(clock.now.get()),"args":args.iter().map(normalized).collect::<Vec<_>>()}));
            for reaction in &input.reactions {
                if reaction.when == fire.get() {
                    for next in &reaction.actions {
                        let holder = holder.upgrade().expect("wrapper retained");
                        // Record nested calls locally: the callback itself may recurse.
                        let mut observed = Vec::new();
                        let result = action(
                            holder.borrow().as_ref().unwrap(),
                            &clock,
                            next,
                            &mut observed,
                        );
                        nested_calls.borrow_mut().extend(observed);
                        if let Err(error) = result {
                            std::panic::panic_any(error);
                        }
                    }
                }
            }
        }
    };
    let edges = Edges {
        leading: input.options.leading,
        trailing: input.options.trailing,
    };
    let wrapper = match input.kind.as_str() {
        "debounce" => Wrapper::Debounce(observe!(
            calls,
            demlik_tea::timing::debounce,
            callback,
            input.ms.value(),
            edges,
            clock.clone()
        )),
        "throttle" => Wrapper::Throttle(observe!(
            calls,
            demlik_tea::timing::throttle,
            callback,
            input.ms.value(),
            edges,
            clock.clone()
        )),
        _ => return Err("unknown wrapper kind".into()),
    };
    *holder.borrow_mut() = Some(wrapper);
    for next in &input.actions {
        let mut observed = Vec::new();
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            action(
                holder.borrow().as_ref().unwrap(),
                &clock,
                next,
                &mut observed,
            )
        }));
        calls.extend(observed);
        match outcome {
            Ok(Ok(())) => {}
            Ok(Err(error)) => clock.error("action", timer_error(&error)),
            Err(payload) => clock.error("action", panic_error(payload.as_ref())),
        }
    }
    calls.extend(nested_calls.borrow().iter().copied());
    Ok(
        json!({"fires":*output.borrow(),"timers":*clock.events.borrow(),"errors":*clock.errors.borrow(),"active":clock.active()}),
    )
}
