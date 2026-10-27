#[path = "agent_snapshot_grid/scenario.rs"]
mod scenario;
use std::io::{self, BufRead};
fn main() {
    let host = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&host, async {
        for line in io::stdin().lock().lines() {
            let input = serde_json::from_str(&line.unwrap()).expect("precise snapshot grid input");
            println!("{}", scenario::execute(input).await);
        }
    });
}
