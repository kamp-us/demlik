use std::{
    io,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use crate::bot::{self, BotRuntime, Model, Msg, ReplyClient, ReplyError, Request};

#[derive(Clone, Debug)]
pub struct Attempt {
    pub channel_id: u64,
    pub text: String,
    pub delivered: bool,
}

#[derive(Clone, Default)]
struct DemoReplies {
    fail_next: Arc<AtomicBool>,
    attempts: Arc<Mutex<Vec<Attempt>>>,
}

impl ReplyClient for DemoReplies {
    async fn reply(&self, channel_id: u64, text: &str) -> Result<(), ReplyError> {
        tokio::task::yield_now().await;
        let delivered = !self.fail_next.swap(false, Ordering::SeqCst);
        self.attempts.lock().unwrap().push(Attempt {
            channel_id,
            text: text.to_owned(),
            delivered,
        });
        if delivered {
            println!("  channel {channel_id} ← {text}");
            Ok(())
        } else {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "intentional offline demo failure",
            )
            .into())
        }
    }
}

pub struct Report {
    pub state: Arc<Model>,
    pub attempts: Vec<Attempt>,
}

async fn request(
    runtime: &BotRuntime,
    channel_id: u64,
    request: Request,
) -> Result<(), ReplyError> {
    runtime
        .dispatch(Msg::Requested {
            channel_id,
            request,
        })
        .await
        .map_err(|error| io::Error::other(error.to_string()))?;
    Ok(())
}

pub async fn run() -> Result<Report, ReplyError> {
    println!("Offline Discord demo: real Rust machine, simulated network.");
    let replies = DemoReplies::default();
    let runtime = bot::start(replies.clone());
    let result = async {
        runtime
            .ready()
            .await
            .map_err(|error| io::Error::other(error.to_string()))?;
        for channel_id in [17, 29, 43] {
            println!("channel {channel_id} → !ping");
            request(&runtime, channel_id, Request::Ping).await?;
        }
        println!("INTENTIONAL DEMO FAILURE: the next reply to channel 29 will fail.");
        replies.fail_next.store(true, Ordering::SeqCst);
        request(&runtime, 29, Request::Ping).await?;
        println!("Recovery: the same machine receives another !ping.");
        request(&runtime, 29, Request::Ping).await?;
        for channel_id in [17, 29, 43] {
            println!("channel {channel_id} → !stats");
            request(&runtime, channel_id, Request::Stats).await?;
        }
        let state = runtime.get_state().expect("completed machine");
        let attempts = replies.attempts.lock().unwrap().clone();
        Ok::<_, ReplyError>(Report { state, attempts })
    }
    .await;
    runtime.stop().await;
    result
}

/// Real café timers and runtime, with replies printed locally instead of sent to Discord.
pub async fn cafe_run() -> Result<Report, ReplyError> {
    println!("Offline café: same Rust shop, simulated Discord replies, real 6s/8s/2.5s timers.");
    let replies = DemoReplies::default();
    let runtime = bot::start(replies.clone());
    let result = async {
        runtime
            .ready()
            .await
            .map_err(|e| io::Error::other(e.to_string()))?;
        for text in ["!cay 1 2", "!heat", "!cay 2 2", "!cay 3 2"] {
            println!("you → {text}");
            cafe_request(&runtime, bot::parse_request(text).unwrap()).await?;
        }
        cafe_wait(&runtime, |m| {
            m.channels[&17].shop.phase == crate::cafe::domain::Phase::Hot
        })
        .await?;
        for batch in [
            &["!brew"][..],
            &["!serve 1", "!serve 2", "!serve 3"][..],
            &["!orders"][..],
        ] {
            for text in batch {
                println!("you → {text}");
                cafe_request(&runtime, bot::parse_request(text).unwrap()).await?;
            }
            if batch[0] == "!brew" {
                cafe_wait(&runtime, |m| {
                    m.channels[&17].shop.phase == crate::cafe::domain::Phase::Ready
                })
                .await?;
            } else if batch[0] == "!serve 1" {
                cafe_wait(&runtime, |m| m.channels[&17].shop.served == 6).await?;
            }
        }
        Ok(Report {
            state: runtime.get_state().expect("running shop"),
            attempts: replies.attempts.lock().unwrap().clone(),
        })
    }
    .await;
    runtime.stop().await;
    result
}

async fn cafe_request(runtime: &BotRuntime, request: Request) -> Result<(), ReplyError> {
    let ack = Arc::new(tokio::sync::Notify::new());
    let observed = Arc::clone(&ack);
    let _unsubscribe = runtime.observe(move |message, _| {
        if matches!(message, Msg::ReplyFinished { channel_id: 17, .. }) {
            observed.notify_one();
        }
    });
    runtime
        .producer()
        .emit(Msg::Requested {
            channel_id: 17,
            request,
        })
        .map_err(|e| io::Error::other(e.to_string()))?;
    tokio::time::timeout(std::time::Duration::from_secs(18), ack.notified()).await?;
    Ok(())
}

async fn cafe_wait(runtime: &BotRuntime, ready: impl Fn(&Model) -> bool) -> Result<(), ReplyError> {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            if ready(&runtime.get_state().expect("running shop")) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await?;
    Ok(())
}
