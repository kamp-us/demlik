#[path = "../examples/agent_runtime/scenario.rs"]
mod scenario;
use serde_json::json;
#[tokio::test(flavor = "current_thread")]
async fn invoice_files_are_collected_checked_and_summarized_by_the_actual_agent_runtime() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in ["promise", "effect"] {
                let out = scenario::execute(
                    serde_json::from_value(json!({"profile":profile,"scenario":"normal"})).unwrap(),
                )
                .await;
                assert_eq!(out["view"]["state"]["phase"], "done");
                assert_eq!(
                    out["view"]["state"]["output"],
                    "Invoice total confirmed: 15"
                );
                assert_eq!(out["view"]["modelCalls"], 5);
                assert_eq!(out["view"]["toolCalls"], 2);
                assert_eq!(out["view"]["state"]["retryKeys"], json!([]));
                assert_eq!(out["view"]["schemaSame"], true);
                assert_eq!(out["view"]["savedSame"], true);
                assert_eq!(out["view"]["reports"], json!([]));
            }
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn rejected_and_resumed_invoice_histories_retain_their_actual_failure_and_state_owners() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in ["promise", "effect"] {
                for scenario in [
                    "duplicate",
                    "stale-settlements",
                    "terminal-boot",
                    "bad-total",
                    "model-error",
                    "parse-error",
                    "retry-once",
                    "retry-exhaust",
                    "restart-brain",
                    "restart-tool",
                    "restart-tool-io-error",
                    "fresh-boot",
                    "cancel",
                    "late-tool-fail",
                    "deadline",
                ] {
                    let output = scenario::execute(
                        serde_json::from_value(json!({"profile":profile,"scenario":scenario}))
                            .unwrap(),
                    )
                    .await;
                    let view = &output["view"];
                    assert_eq!(view["savedSame"], true);
                    match scenario {
                        "model-error" | "parse-error" | "retry-exhaust" => {
                            assert_eq!(view["state"]["failure"], "llm");
                            assert_eq!(view["state"]["causeSame"], true);
                            assert_eq!(view["doneSame"], true);
                        }
                        "restart-tool-io-error" => {
                            assert_eq!(view["dispatchFailures"], json!([null, "tool-io"]));
                            assert_eq!(view["state"]["awaiting"], "tools");
                        }
                        "fresh-boot" => {
                            assert_eq!(view["state"]["phase"], "idle");
                            assert_eq!(view["modelCalls"], 0);
                        }
                        "cancel" | "late-tool-fail" => {
                            assert_eq!(view["state"]["phase"], "cancelled");
                            assert_eq!(view["state"]["records"], json!([]));
                            assert_eq!(view["modelCalls"], 1);
                        }
                        "deadline" => assert_eq!(view["state"]["phase"], "failed"),
                        _ => {
                            assert_eq!(view["state"]["phase"], "done");
                            assert_eq!(view["state"]["calls"]["collect"], "succeeded");
                            assert_eq!(view["state"]["retryKeys"], json!([]));
                            assert_eq!(view["toolCalls"], 2);
                        }
                    }
                    if scenario.starts_with("restart") || scenario == "terminal-boot" {
                        assert_eq!(view["restart"]["loadedSame"], true);
                        assert_eq!(view["restart"]["newModelCallsAtReady"], 0);
                    }
                    if scenario == "bad-total" {
                        assert_eq!(view["state"]["output"], "Invoice requires review");
                    }
                    if scenario == "retry-once" {
                        assert_eq!(view["requestReused"], true);
                        assert_eq!(view["modelCalls"], 6);
                        assert!(
                            view["timers"]
                                .as_array()
                                .unwrap()
                                .windows(2)
                                .any(|pair| pair[0] == json!(["arm", 22.25])
                                    && pair[1] == json!(["arm", 100.0]))
                        );
                    }
                }
            }
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn loaded_projection_refusal_retains_deadline_kind_and_declared_agent_error() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for profile in ["promise", "effect"] {
                let out = scenario::execute(
                    serde_json::from_value(
                        json!({"profile":profile,"scenario":"projection-error"}),
                    )
                    .unwrap(),
                )
                .await;
                assert_eq!(
                    out["projectionFailure"],
                    json!({"kind":"deadline","cause":"declared","profile":"missing compaction"})
                );
                assert_eq!(out["view"]["modelCalls"], 0);
            }
        })
        .await;
}
