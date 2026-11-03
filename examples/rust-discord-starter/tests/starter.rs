use demlik_discord_starter::demo;
use std::process::Command;

#[tokio::test(flavor = "current_thread")]
async fn demo_runs_three_channels_through_failure_and_recovery() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let report = demo::run().await.unwrap();
            assert_eq!(report.attempts.len(), 8);
            assert_eq!(
                report
                    .attempts
                    .iter()
                    .filter(|attempt| attempt.delivered)
                    .count(),
                7
            );
            assert_eq!(report.state.channels.len(), 3);
            assert_eq!(
                (
                    report.state.channels[&17].delivered,
                    report.state.channels[&17].failed
                ),
                (2, 0)
            );
            assert_eq!(
                (
                    report.state.channels[&29].delivered,
                    report.state.channels[&29].failed
                ),
                (3, 1)
            );
            assert_eq!(
                (
                    report.state.channels[&43].delivered,
                    report.state.channels[&43].failed
                ),
                (2, 0)
            );
            assert!(report.state.channels[&29].last_error.is_none());
            assert_eq!(
                report.attempts[6].text,
                "This channel: 2 delivered, 1 failed. This stats reply is not counted yet."
            );
        })
        .await;
}

#[test]
fn invalid_startup_exits_before_connecting() {
    let binary = env!("CARGO_BIN_EXE_demlik-discord-starter");
    for arguments in [&["unknown"][..], &["live", "extra"][..], &["live"][..]] {
        let result = Command::new(binary)
            .args(arguments)
            .env_remove("DISCORD_TOKEN")
            .output()
            .unwrap();
        assert!(!result.status.success());
        let output = String::from_utf8(result.stdout).unwrap();
        assert!(!output.contains("Connecting"));
        assert!(!String::from_utf8(result.stderr).unwrap().is_empty());
    }
}
