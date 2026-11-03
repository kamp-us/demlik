use std::{env, io, sync::Arc, time::Duration};

use demlik_tea::runtime::{DispatchRefused, Producer};
use serenity::{
    Client,
    all::{ChannelId, GatewayIntents, Message, Ready},
    async_trait,
    client::{Context, EventHandler},
    http::Http,
};

use crate::bot::{self, Msg, ReplyClient, ReplyError, parse_request};

pub struct Config {
    token: String,
}

impl Config {
    pub fn from_env() -> Result<Self, ReplyError> {
        let token = env::var("DISCORD_TOKEN")
            .map_err(|_| io::Error::other("set DISCORD_TOKEN before running live mode"))?;
        if token.trim().is_empty() {
            return Err(io::Error::other("DISCORD_TOKEN must not be empty").into());
        }
        Ok(Self { token })
    }
}

pub struct DiscordReplies {
    pub http: Arc<Http>,
}

impl ReplyClient for DiscordReplies {
    async fn reply(&self, channel_id: u64, text: &str) -> Result<(), ReplyError> {
        ChannelId::new(channel_id).say(&self.http, text).await?;
        Ok(())
    }
}

struct Gateway {
    producer: Producer<Msg>,
}

impl Gateway {
    fn forward(&self, message: &Message) -> Result<(), DispatchRefused> {
        if message.author.bot {
            return Ok(());
        }
        if let Some(request) = parse_request(&message.content) {
            self.producer.emit(Msg::Requested {
                channel_id: message.channel_id.get(),
                request,
            })?;
        }
        Ok(())
    }
}

#[async_trait]
impl EventHandler for Gateway {
    async fn message(&self, _: Context, message: Message) {
        if let Err(error) = self.forward(&message) {
            eprintln!("Discord event could not reach the machine: {error}");
        }
    }

    async fn ready(&self, _: Context, ready: Ready) {
        println!(
            "Connected as {}. Send !ping, !stats, or !help. Ctrl+C stops the bot.",
            ready.user.name
        );
    }
}

pub async fn run(config: Config) -> Result<(), ReplyError> {
    let http = Arc::new(Http::new(&config.token));
    let runtime = bot::start(DiscordReplies { http });
    let outcome = async {
        runtime.ready().await.map_err(|error| io::Error::other(error.to_string()))?;
        let intents = GatewayIntents::GUILD_MESSAGES
            | GatewayIntents::DIRECT_MESSAGES
            | GatewayIntents::MESSAGE_CONTENT;
        let builder = Client::builder(&config.token, intents)
            .event_handler(Gateway { producer: runtime.producer() });
        println!("Connecting to Discord...");
        let mut client = tokio::time::timeout(Duration::from_secs(30), async { builder.await })
            .await??;
        let shards = Arc::clone(&client.shard_manager);
        let result = tokio::select! {
            result = client.start() => result.map_err(|error| Box::new(error) as ReplyError),
            result = tokio::signal::ctrl_c() => result.map_err(|error| Box::new(error) as ReplyError),
        };
        shards.shutdown_all().await;
        result
    }.await;
    runtime.stop().await;
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use serenity::http::{HttpBuilder, HttpError};
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::TcpListener,
        sync::Mutex,
        thread,
        time::Instant,
    };

    fn message(channel: u64, content: &str, bot: bool) -> Value {
        json!({
            "id": "123", "channel_id": channel.to_string(),
            "author": { "id": "456", "username": "fixture", "discriminator": "0", "avatar": null, "bot": bot },
            "content": content, "timestamp": "2026-11-02T00:00:00Z", "edited_timestamp": null,
            "tts": false, "mention_everyone": false, "mentions": [], "mention_roles": [],
            "attachments": [], "embeds": [], "pinned": false, "type": 0
        })
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sdk_messages_reach_the_machine_and_real_http_errors_remain_typed() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(8);
            let mut requests = Vec::new();
            while requests.len() < 7 && Instant::now() < deadline {
                let (stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => panic!("{error}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut input = BufReader::new(stream);
                let mut first = String::new();
                input.read_line(&mut first).unwrap();
                let mut size = 0;
                let mut authorization = String::new();
                loop {
                    let mut line = String::new();
                    input.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    let (key, value) = line.split_once(':').unwrap();
                    if key.eq_ignore_ascii_case("content-length") {
                        size = value.trim().parse::<usize>().unwrap();
                    }
                    if key.eq_ignore_ascii_case("authorization") {
                        authorization = value.trim().to_owned();
                    }
                }
                let mut body = vec![0; size];
                input.read_exact(&mut body).unwrap();
                let body: Value = serde_json::from_slice(&body).unwrap();
                let denied = requests.len() == 3;
                requests.push((first, authorization, body));
                let (status, response) = if denied {
                    (
                        "403 Forbidden",
                        json!({"code": 50013, "message": "Missing Permissions"}),
                    )
                } else {
                    (
                        "200 OK",
                        message(
                            [17, 29, 43, 29, 29, 29, 43][requests.len() - 1],
                            "fixture response",
                            true,
                        ),
                    )
                };
                let response = serde_json::to_vec(&response).unwrap();
                write!(input.get_mut(), "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response.len()).unwrap();
                input.get_mut().write_all(&response).unwrap();
            }
            assert_eq!(
                requests.len(),
                7,
                "all SDK requests must reach the local server"
            );
            requests
        });

        // Serenity's active rate limiter bypasses HttpBuilder.proxy.
        // Keep even an accidental direct Discord route on loopback.
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .resolve("discord.com", "127.0.0.1:0".parse().unwrap())
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let http = HttpBuilder::new("offline-sdk-test")
            .client(client)
            .proxy(format!("http://{address}"))
            .ratelimiter_disabled(true)
            .build();
        let failures = Arc::new(Mutex::new(Vec::new()));
        tokio::task::LocalSet::new()
            .run_until(async {
                let runtime = bot::start(DiscordReplies {
                    http: Arc::new(http),
                });
                runtime.ready().await.unwrap();
                let observed = Arc::clone(&failures);
                let _unsubscribe = runtime.observe(move |message, _| {
                    if let Msg::ReplyFinished {
                        result: Err(error), ..
                    } = message
                    {
                        let original = error
                            .downcast_ref::<serenity::Error>()
                            .expect("original SDK error");
                        let serenity::Error::Http(HttpError::UnsuccessfulRequest(response)) =
                            original
                        else {
                            panic!("expected an actual decoded HTTP refusal");
                        };
                        observed
                            .lock()
                            .unwrap()
                            .push((response.status_code.as_u16(), response.error.code));
                    }
                });
                let gateway = Arc::new(Gateway {
                    producer: runtime.producer(),
                });
                for (channel, text, bot_author) in
                    [(17, "!ping", true), (17, "ordinary chat", false)]
                {
                    let payload: Message =
                        serde_json::from_value(message(channel, text, bot_author)).unwrap();
                    gateway.forward(&payload).unwrap();
                }
                runtime.idle().await.unwrap();
                assert!(runtime.get_state().unwrap().channels.is_empty());

                for (channel, text) in [
                    (17, "!ping"),
                    (29, "!ping"),
                    (43, "!ping"),
                    (29, "!ping"),
                    (29, "!ping"),
                    (29, "!stats"),
                    (43, "!help"),
                ] {
                    let before = runtime.get_state().unwrap();
                    let previous = before
                        .channels
                        .get(&channel)
                        .map(|state| state.delivered + state.failed)
                        .unwrap_or(0);
                    let payload = serde_json::from_value(message(channel, text, false)).unwrap();
                    let sender = Arc::clone(&gateway);
                    tokio::spawn(async move { sender.forward(&payload) })
                        .await
                        .unwrap()
                        .unwrap();
                    tokio::time::timeout(Duration::from_secs(3), async {
                        loop {
                            runtime.idle().await.unwrap();
                            if runtime
                                .get_state()
                                .unwrap()
                                .channels
                                .get(&channel)
                                .is_some_and(|state| state.delivered + state.failed > previous)
                            {
                                break;
                            }
                            tokio::time::sleep(Duration::from_millis(1)).await;
                        }
                    })
                    .await
                    .unwrap();
                }
                let state = runtime.get_state().unwrap();
                assert_eq!(
                    (state.channels[&17].delivered, state.channels[&17].failed),
                    (1, 0)
                );
                assert_eq!(
                    (state.channels[&29].delivered, state.channels[&29].failed),
                    (3, 1)
                );
                assert_eq!(
                    (state.channels[&43].delivered, state.channels[&43].failed),
                    (2, 0)
                );
                assert!(
                    state.channels[&29].last_error.is_none(),
                    "success clears the prior failure"
                );
                assert!(
                    runtime.reports().is_empty(),
                    "an HTTP refusal is handled as application data"
                );
                runtime.stop().await;
            })
            .await;
        assert_eq!(*failures.lock().unwrap(), vec![(403, 50013)]);
        let requests = server.join().unwrap();
        for ((request, authorization, _), channel) in
            requests.iter().zip([17, 29, 43, 29, 29, 29, 43])
        {
            assert!(request.starts_with("POST "));
            assert!(
                request
                    .split_whitespace()
                    .nth(1)
                    .unwrap()
                    .ends_with(&format!("/channels/{channel}/messages"))
            );
            assert_eq!(authorization, "Bot offline-sdk-test");
        }
        assert_eq!(requests[0].2["content"], "pong 🫖");
        assert_eq!(
            requests[5].2["content"],
            "This channel: 2 delivered, 1 failed. This stats reply is not counted yet."
        );
    }
}
