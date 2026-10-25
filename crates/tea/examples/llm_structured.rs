#[path = "llm_structured/consumer.rs"]
mod consumer;
#[tokio::main(flavor = "current_thread")]
async fn main() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [
                demlik_tea::runtime::Profile::Promise,
                demlik_tea::runtime::Profile::Effect,
            ] {
                println!("{}", consumer::run(profile, "success").await);
            }
        })
        .await;
}
