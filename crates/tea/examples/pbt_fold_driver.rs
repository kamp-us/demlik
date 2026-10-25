use serde::Deserialize;
use serde_json::Value;
use std::{
    cell::RefCell,
    io::{self, BufRead},
    rc::Rc,
};
#[path = "../../parity/src/paginate_queue/wire.rs"]
mod wire;
type Calls = Rc<RefCell<Vec<&'static str>>>;
macro_rules! observe{($calls:expr,$function:path $(,$arg:expr)*$(,)?)=>{{$calls.borrow_mut().push(stringify!($function));$function($($arg),*)}};}
#[path = "pbt_fold/counter.rs"]
mod counter;
#[path = "pbt_fold/intake.rs"]
mod intake;
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Script {
    Counter(counter::Script),
    Intake(intake::Script),
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    input: Script,
}
fn execute(case: Case) -> Value {
    let calls = Calls::default();
    let comparison = match case.input {
        Script::Counter(s) => counter::run(s, &calls),
        Script::Intake(s) => intake::run(s, &calls),
    };
    serde_json::json!({"id":case.id,"comparison":comparison,"observedRustCalls":calls.borrow().clone()})
}
fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        println!("{}", execute(serde_json::from_str(&line).unwrap()));
    }
}
