#[path = "../examples/timestamp_runtime/consumer.rs"]
mod consumer;
#[tokio::test(flavor = "current_thread")]
async fn actual_command_outcomes_survive_message_persistence_in_both_profiles() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in [
                demlik_tea::runtime::Profile::Promise,
                demlik_tea::runtime::Profile::Effect,
            ] {
                for at in [17.25, 0.0, -0.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
                    for mode in [
                        consumer::Mode::Success,
                        consumer::Mode::Failure,
                        consumer::Mode::Retry,
                    ] {
                        let result = consumer::run(
                            profile,
                            mode,
                            serde_json::from_value(consumer::wire::number(at)).unwrap(),
                        )
                        .await;
                        assert_eq!(result["value"]["done"], true);
                        if !at.is_finite() {
                            assert_eq!(
                                result["value"]["rows"][0]["restored"],
                                serde_json::Value::Null
                            );
                            assert_eq!(
                                result["value"]["rows"][1]["clock"],
                                serde_json::Value::Null
                            );
                        }
                        assert_eq!(
                            result["value"]["providerCalls"],
                            if matches!(mode, consumer::Mode::Retry) {
                                2
                            } else {
                                1
                            }
                        );
                    }
                }
            }
        })
        .await;
}
