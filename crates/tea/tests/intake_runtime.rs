#[path = "../examples/intake_runtime/consumer.rs"]
mod consumer;
use demlik_tea::runtime::Profile;
#[tokio::test(flavor = "current_thread")]
async fn a_saved_completion_survives_a_fresh_runtime_without_reexecuting_the_worker() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [Profile::Promise, Profile::Effect] {
                let output =
                    consumer::run(profile, consumer::Mode::Done, consumer::Storage::Bytes).await;
                assert_eq!(output["value"]["snapshots"][0]["workers"], 1);
                assert_eq!(output["value"]["snapshots"][1]["workers"], 1);
                assert_eq!(output["value"]["snapshots"][1]["replays"], 1);
                assert_eq!(
                    output["value"]["snapshots"][1]["state"]["intake"]["queue"][0]["status"],
                    "running"
                );
            }
        })
        .await;
}
