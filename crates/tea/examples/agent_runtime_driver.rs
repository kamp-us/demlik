#[path = "agent_runtime/scenario.rs"]
mod scenario;
use std::io::{self, BufRead};
fn main() {
    let host = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    tokio::task::LocalSet::new().block_on(&host, async {
        for row in io::stdin().lock().lines() {
            let text = row.unwrap();
            let input: scenario::Input =
                serde_json::from_str(&text).expect("precise agent runtime script");
            println!("{}", scenario::execute(input).await);
        }
    });
}
