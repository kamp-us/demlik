use demlik_discord_starter::{
    bot::{self, BotRuntime, Msg, ReplyClient, ReplyError, Request},
    cafe::{
        self,
        domain::{OrderStatus, Phase},
    },
};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Default)]
struct Replies(Arc<Mutex<Vec<(u64, String)>>>);
impl ReplyClient for Replies {
    async fn reply(&self, channel: u64, text: &str) -> Result<(), ReplyError> {
        self.0.lock().unwrap().push((channel, text.to_owned()));
        Ok(())
    }
}

async fn send(runtime: &BotRuntime, channel_id: u64, text: &str) {
    let request = bot::parse_request(text).expect("recognized command");
    let ack = Arc::new(tokio::sync::Notify::new());
    let observed = Arc::clone(&ack);
    let _unsubscribe = runtime.observe(move |message, _| {
        if matches!(message, Msg::ReplyFinished { channel_id: id, .. } if *id == channel_id) {
            observed.notify_one();
        }
    });
    // Match the SDK callback: enqueue without awaiting earlier command barriers.
    runtime
        .producer()
        .emit(Msg::Requested {
            channel_id,
            request,
        })
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), ack.notified())
        .await
        .unwrap_or_else(|_| panic!("{text}: a pending café timer blocked the Discord inbox"));
}
async fn advance(runtime: &BotRuntime, millis: u64, completions: usize) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let seen = Arc::new(AtomicUsize::new(0));
    let observed = Arc::clone(&seen);
    let wake = Arc::new(tokio::sync::Notify::new());
    let notify = Arc::clone(&wake);
    let _unsubscribe = runtime.observe(move |message, _| {
        if matches!(message, Msg::CafeFinished { .. }) {
            observed.fetch_add(1, Ordering::SeqCst);
            notify.notify_one();
        }
    });
    tokio::time::advance(Duration::from_millis(millis)).await;
    tokio::time::timeout(Duration::from_secs(1), async {
        while seen.load(Ordering::SeqCst) < completions {
            wake.notified().await;
        }
    })
    .await
    .expect("expected timer completions must reach the actual machine");
    runtime.idle().await.unwrap();
}

#[test]
fn malformed_commands_produce_usage_and_ordinary_chat_is_ignored() {
    for text in [
        "!cay 0",
        "!cay 4",
        "!cay -1",
        "!cay 1 0",
        "!cay 1 7",
        "!cay 1 2 extra",
        "!serve",
        "!serve 0",
        "!serve 999999999999",
        "!cancel -1",
        "!heat now",
    ] {
        assert!(
            matches!(bot::parse_request(text), Some(Request::Invalid(_))),
            "{text}"
        );
    }
    assert_eq!(bot::parse_request("ordinary conversation"), None);
    assert_eq!(bot::parse_request("!another-bot"), None);
    assert_eq!(
        bot::parse_request(" !çay 3 6 "),
        Some(Request::Cafe(cafe::Action::Order {
            table: 3,
            glasses: 6
        }))
    );
}

#[tokio::test(start_paused = true)]
async fn shared_shop_serves_six_glasses_accepts_orders_while_heating_and_isolates_channels() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let replies = Replies::default();
            let runtime = bot::start(replies.clone());
            runtime.ready().await.unwrap();
            send(&runtime, 17, "!cay 1 2").await;
            send(&runtime, 17, "!heat").await;
            assert_eq!(
                runtime.get_state().unwrap().channels[&17].shop.phase,
                Phase::Heating
            );
            send(&runtime, 17, "!cay 2 2").await;
            send(&runtime, 17, "!cay 3 2").await;
            send(&runtime, 29, "!cay 1 1").await;
            assert_eq!(
                runtime.get_state().unwrap().channels[&17].shop.orders.len(),
                3
            );
            assert_eq!(
                runtime.get_state().unwrap().channels[&29].shop.phase,
                Phase::Cold
            );
            advance(&runtime, 6000, 1).await;
            assert_eq!(
                runtime.get_state().unwrap().channels[&17].shop.phase,
                Phase::Hot
            );
            send(&runtime, 17, "!brew").await;
            advance(&runtime, 8000, 1).await;
            send(&runtime, 17, "!serve 1").await;
            send(&runtime, 17, "!serve 2").await;
            send(&runtime, 17, "!serve 3").await;
            advance(&runtime, 2500, 3).await;
            send(&runtime, 17, "!orders").await;
            let state = runtime.get_state().unwrap();
            let shop = &state.channels[&17].shop;
            assert_eq!(
                (shop.water, shop.leaves, shop.tea, shop.served),
                (6, 3, 0, 6)
            );
            assert!(shop.orders.iter().all(|o| o.status == OrderStatus::Served));
            assert_eq!(
                state.channels[&29].shop.orders[0].status,
                OrderStatus::Waiting
            );
            assert_eq!(state.channels[&29].shop.served, 0);
            let sent = replies.0.lock().unwrap();
            assert!(
                sent.iter()
                    .any(|(id, t)| *id == 17 && t.contains("Su kaynadı"))
            );
            assert!(
                sent.iter()
                    .any(|(id, t)| *id == 17 && t.contains("6 bardak çay hazır"))
            );
            assert!(
                sent.last()
                    .unwrap()
                    .1
                    .contains("#3 · table 3 · 2 glasses · served")
            );
            drop(sent);
            assert!(runtime.reports().is_empty());
            runtime.stop().await;
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn invalid_actions_and_empty_water_are_visible_recovery_works_and_reset_discards_late_brew() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let replies = Replies::default();
            let runtime = bot::start(replies.clone());
            runtime.ready().await.unwrap();
            send(&runtime, 17, "!cay 1 99").await;
            assert!(
                runtime.get_state().unwrap().channels[&17]
                    .shop
                    .orders
                    .is_empty()
            );
            assert!(
                replies
                    .0
                    .lock()
                    .unwrap()
                    .last()
                    .unwrap()
                    .1
                    .contains("Usage:")
            );
            send(&runtime, 17, "!brew").await;
            assert!(
                runtime.get_state().unwrap().channels[&17]
                    .shop
                    .error
                    .is_some()
            );
            send(&runtime, 17, "!empty").await;
            send(&runtime, 17, "!heat").await;
            advance(&runtime, 6000, 1).await;
            assert_eq!(
                runtime.get_state().unwrap().channels[&17].shop.phase,
                Phase::Cold
            );
            assert!(
                replies
                    .0
                    .lock()
                    .unwrap()
                    .last()
                    .unwrap()
                    .1
                    .contains("Semaverde su yok")
            );
            send(&runtime, 17, "!water").await;
            send(&runtime, 17, "!heat").await;
            advance(&runtime, 6000, 1).await;
            send(&runtime, 17, "!cay 2 2").await;
            send(&runtime, 17, "!cancel 1").await;
            assert_eq!(
                runtime.get_state().unwrap().channels[&17].shop.orders[0].status,
                OrderStatus::Cancelled
            );
            send(&runtime, 17, "!brew").await;
            send(&runtime, 17, "!reset").await;
            let count = replies.0.lock().unwrap().len();
            advance(&runtime, 8000, 1).await;
            let state = runtime.get_state().unwrap();
            let shop = &state.channels[&17].shop;
            assert_eq!(
                (shop.water, shop.leaves, shop.tea, shop.served),
                (12, 4, 0, 0)
            );
            assert_eq!(shop.phase, Phase::Cold);
            assert!(shop.orders.is_empty());
            assert_eq!(
                replies.0.lock().unwrap().len(),
                count,
                "old shift must not announce a completion"
            );
            runtime.stop().await;
        })
        .await;
}
