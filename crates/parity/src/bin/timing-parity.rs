use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{self, BufRead};
macro_rules! observe {($calls:expr,$call:path $(,$arg:expr)* $(,)?)=>{{let result=$call($($arg),*);$calls.push(stringify!($call));result}};}
#[path = "../timing/mod.rs"]
mod timing;
#[derive(Deserialize)]
struct Case {
    id: String,
    operation: String,
    input: Value,
}
fn main() {
    for line in io::stdin().lock().lines() {
        let response = match line {
            Ok(line) => match serde_json::from_str::<Case>(&line) {
                Ok(case) => {
                    let mut calls = Vec::new();
                    match timing::execute(&case.operation, case.input, &mut calls) {
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
