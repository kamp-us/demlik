#[path = "timestamp_runtime/consumer.rs"]
mod consumer;
use consumer::{Mode, wire::Number};
use serde::Deserialize;
use serde_json::json;
use std::io::{self, BufRead};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    id: String,
    profile: String,
    mode: Mode,
    at: Number,
}
#[tokio::main(flavor = "current_thread")]
async fn main() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for line in io::stdin().lock().lines() {
                let input: Input = serde_json::from_str(&line.unwrap()).unwrap();
                let profile = match input.profile.as_str() {
                    "promise" => demlik_tea::runtime::Profile::Promise,
                    "effect" => demlik_tea::runtime::Profile::Effect,
                    _ => panic!("profile"),
                };
                println!(
                    "{}",
                    json!({"id":input.id,"output":consumer::run(profile,input.mode,input.at).await})
                );
            }
        })
        .await;
}
