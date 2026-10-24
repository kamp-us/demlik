use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{self, BufRead};
macro_rules! observe {($calls:expr,$call:path $(,$arg:expr)* $(,)?)=>{{let result=$call($($arg),*);$calls.push(stringify!($call));result}};}
macro_rules! observe_async {($calls:expr,$call:path $(,$arg:expr)* $(,)?)=>{{let result=$call($($arg),*).await;$calls.push(stringify!($call));result}};}
#[path = "../paginate_queue/mod.rs"]
mod paginate_queue;
#[derive(Deserialize)]
struct Case {
    id: String,
    operation: String,
    input: Value,
}
fn main() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let local = tokio::task::LocalSet::new();
    for line in io::stdin().lock().lines() {
        let response = match line {
            Ok(line) => match serde_json::from_str::<Case>(&line) {
                Ok(case) => {
                    let mut calls = Vec::new();
                    match local.block_on(
                        &runtime,
                        paginate_queue::execute(&case.operation, case.input, &mut calls),
                    ) {
                        Ok(output) => {
                            json!({"id":case.id,"ok":true,"output":output,"observedCalls":calls})
                        }
                        Err(message) => {
                            json!({"id":case.id,"ok":false,"error":{"kind":"driver_error","message":message}})
                        }
                    }
                }
                Err(error) => {
                    json!({"ok":false,"error":{"kind":"driver_error","message":error.to_string()}})
                }
            },
            Err(error) => {
                json!({"ok":false,"error":{"kind":"driver_error","message":error.to_string()}})
            }
        };
        println!("{response}");
    }
}
