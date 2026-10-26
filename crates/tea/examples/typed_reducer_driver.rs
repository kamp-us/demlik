use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::RefCell,
    io::{self, BufRead},
    rc::Rc,
};

#[path = "typed_reducer/actor.rs"]
mod actor;
#[path = "typed_reducer/pure.rs"]
mod pure;

type Calls = Rc<RefCell<Vec<&'static str>>>;
macro_rules! observe {
    ($calls:expr, $function:path $(, $arg:expr)* $(,)?) => {{
        let value = $function($($arg),*);
        $calls.borrow_mut().push(stringify!($function));
        value
    }};
}
pub(crate) use observe;
macro_rules! observe_async {
    ($calls:expr, $function:path $(, $arg:expr)* $(,)?) => {{
        let value = $function($($arg),*).await;
        $calls.borrow_mut().push(stringify!($function));
        value
    }};
}
pub(crate) use observe_async;

#[derive(Deserialize)]
#[serde(tag = "suite", rename_all = "kebab-case", deny_unknown_fields)]
enum Input {
    Pure {
        verb: pure::Verb,
        scenario: pure::Scenario,
    },
    Actor {
        profile: actor::SelectedProfile,
        policy: actor::Policy,
        scenario: actor::Scenario,
        verb: actor::Verb,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    input: Input,
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    tokio::task::LocalSet::new().run_until(async {
        for line in io::stdin().lock().lines() {
            let line = line.expect("stdin read");
            let answer = match serde_json::from_str::<Request>(&line) {
                Err(error) => json!({"id":Value::Null,"ok":false,"error":{"kind":"protocol","message":error.to_string()}}),
                Ok(request) => {
                    let calls = Rc::new(RefCell::new(vec![]));
                    let output = match request.input {
                        Input::Pure { verb, scenario } => pure::execute(verb, scenario, &calls),
                        Input::Actor { profile, policy, scenario, verb } => actor::execute(profile, policy, scenario, verb, &calls).await,
                    };
                    json!({"id":request.id,"ok":true,"output":output,"observedCalls":*calls.borrow()})
                }
            };
            println!("{answer}");
        }
    }).await;
}
