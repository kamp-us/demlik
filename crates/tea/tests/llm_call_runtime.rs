#[path = "../examples/llm_structured/consumer.rs"]
mod consumer;
#[tokio::test(flavor = "current_thread")]
async fn opaque_two_purpose_workflow_and_projected_error_use_the_real_runtime() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [
                demlik_tea::runtime::Profile::Promise,
                demlik_tea::runtime::Profile::Effect,
            ] {
                for mode in ["success", "provider", "schema"] {
                    let result = consumer::run(profile, mode).await;
                    let value = &result["value"];
                    assert_eq!(value["done"], true);
                    assert_eq!(value["sameContext"], true);
                    assert_eq!(
                        value["providerCalls"],
                        if mode == "success" { 2 } else { 1 }
                    );
                    if mode == "success" {
                        assert_eq!(value["events"][1]["summary"], "2 steps verified");
                        assert_eq!(value["events"][1]["samePlan"], true);
                    } else {
                        assert_eq!(value["events"][0]["sameCause"], true);
                    }
                }
            }
        })
        .await;
}
