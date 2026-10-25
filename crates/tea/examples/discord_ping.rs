use demlik_tea::command::{CommandContractError, CommandFamily};
use demlik_tea::runtime::{
    CommandContext, CommandWork, DriveOptions, Interpreter, NoSubscriptions, Options, Profile,
    drive_to_done, launch,
};
use demlik_tea::{Machine, Step, Sub, Tagged, Update, messages};
use std::convert::Infallible;

#[derive(Clone, Debug, Default)]
struct Model {
    replies: usize,
    last_result: Option<Result<(), String>>,
}

impl Tagged for Model {
    fn tag(&self) -> &str {
        "bot"
    }
}

messages! {
    enum Msg {
        MessageReceived { channel_id: u64, text: String },
        ReplyFinished { result: Result<(), String> },
    }
}

enum Cmd {
    SendReply { channel_id: u64, text: String },
}

fn update(model: &Model, message: &Msg) -> Step<Model, Cmd> {
    match message {
        Msg::MessageReceived { channel_id, text } if text == "!ping" => Step::new(
            Model {
                last_result: None,
                ..model.clone()
            },
            vec![Cmd::SendReply {
                channel_id: *channel_id,
                text: "pong".into(),
            }],
        ),
        Msg::ReplyFinished { result } => Step::new(
            Model {
                replies: model.replies + usize::from(result.is_ok()),
                last_result: Some(result.clone()),
            },
            vec![],
        ),
        Msg::MessageReceived { .. } => Step::new(model.clone(), vec![]),
    }
}

impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match self {
            Self::SendReply { .. } => "sendReply",
        }
    }
}

impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Vec<Msg>;

    fn settle(self, messages: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        Ok(messages)
    }
}

// A local stand-in for a Discord SDK. No token or network connection is used.
struct LocalDiscord;

impl LocalDiscord {
    async fn send_message(&self, channel_id: u64, text: &str) -> Result<(), String> {
        tokio::task::yield_now().await;
        if channel_id == 0 {
            return Err("missing permission to send in this channel".into());
        }
        println!("channel {channel_id}: {text}");
        Ok(())
    }
}

struct Effects {
    discord: LocalDiscord,
}

impl Interpreter<Cmd> for Effects {
    type Error = Infallible;

    fn interpret<'a>(
        &'a self,
        command: &'a Cmd,
        _: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Self::Error>> {
        Some(CommandWork::new(async move {
            match command {
                Cmd::SendReply { channel_id, text } => {
                    let result = self.discord.send_message(*channel_id, text).await;
                    Ok(vec![Msg::ReplyFinished { result }])
                }
            }
        }))
    }
}

async fn run(profile: Profile, channel_id: u64) {
    let machine: Machine<'static, Model, Msg, Cmd, Sub> = Machine {
        init: Box::new(|loaded, _| Step::new(loaded.unwrap_or_default(), vec![])),
        update: Update::reducer(update),
        subscriptions: demlik_tea::core::subscriptions(|_| vec![]),
    };
    let options: Options<Model, Msg, Infallible, Infallible> = Options::new(profile);
    let runtime = launch(
        machine,
        (),
        Effects {
            discord: LocalDiscord,
        },
        NoSubscriptions::new(),
        options,
    );

    let state = drive_to_done(
        &runtime,
        Msg::MessageReceived {
            channel_id,
            text: "!ping".into(),
        },
        |model: &Model| model.last_result.is_some(),
        DriveOptions::default(),
    )
    .await
    .expect("runtime should finish the reply attempt");

    match state.last_result.as_ref().expect("reply result") {
        Ok(()) => assert_eq!(state.replies, 1),
        Err(message) => {
            assert_eq!(state.replies, 0);
            assert_eq!(message, "missing permission to send in this channel");
            println!("reply failed: {message}");
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    tokio::task::LocalSet::new()
        .run_until(async {
            for (name, profile) in [("promise", Profile::Promise), ("effect", Profile::Effect)] {
                println!("{name} profile:");
                run(profile, 42).await;
                run(profile, 0).await;
            }
        })
        .await;
}
