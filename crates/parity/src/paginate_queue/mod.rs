mod paginator;
mod queue;
mod store;
mod wire;
use serde_json::Value;
pub async fn execute(
    operation: &str,
    input: Value,
    calls: &mut Vec<&'static str>,
) -> Result<Value, String> {
    match operation {
        "paginate.paginator" => paginator::execute(input, calls),
        "queue.pure" => queue::execute(input, calls),
        "queue.store" => store::execute(input, calls).await,
        "queue.defaults" => store::defaults(calls).await,
        _ => Err(format!("unsupported operation {operation}")),
    }
}
