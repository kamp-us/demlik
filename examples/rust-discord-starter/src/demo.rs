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
