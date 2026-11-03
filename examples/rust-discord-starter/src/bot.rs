use std::{collections::BTreeMap, convert::Infallible, error::Error, rc::Rc, time::Duration};

use demlik_tea::{
    Machine, Step, Sub, Tagged, Update,
    command::{CommandContractError, CommandFamily},
    messages,
    runtime::{
        CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Profile, Runtime,
        launch,
    },
};

pub type ReplyError = Box<dyn Error + Send + Sync>;
pub type BotRuntime = Runtime<Model, Msg, Infallible, Infallible>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Request {
    Ping,
    Stats,
    Help,
}

pub fn parse_request(text: &str) -> Option<Request> {
    match text.trim() {
        "!ping" => Some(Request::Ping),
        "!stats" => Some(Request::Stats),
        "!help" => Some(Request::Help),
        _ => None,
    }
}

#[derive(Clone, Debug, Default)]
pub struct Channel {
    pub requested: u64,
    pub delivered: u64,
    pub failed: u64,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Model {
    pub channels: BTreeMap<u64, Channel>,
}

impl Tagged for Model {
    fn tag(&self) -> &str {
        "listening"
    }
}

messages! {
    #[derive(Debug)]
    pub enum Msg {
        Requested { channel_id: u64, request: Request },
        ReplyFinished { channel_id: u64, result: Result<(), ReplyError> },
    }
}

pub enum Cmd {
    Reply { channel_id: u64, text: String },
}

impl Tagged for Cmd {
    fn tag(&self) -> &str {
        "reply"
    }
}

impl CommandFamily for Cmd {
    type Msg = Msg;
    type Completion = Vec<Msg>;

    fn settle(self, messages: Vec<Msg>, _: f64) -> Result<Vec<Msg>, CommandContractError> {
        Ok(messages)
    }
}

pub fn update(model: &Model, message: &Msg) -> Step<Model, Cmd> {
    let mut next = model.clone();
    let commands = match message {
        Msg::Requested {
            channel_id,
            request,
        } => {
            let channel = next.channels.entry(*channel_id).or_default();
            channel.requested += 1;
            let text = match request {
                Request::Ping => "pong 🫖".to_owned(),
                Request::Stats => format!(
                    "This channel: {} delivered, {} failed. This stats reply is not counted yet.",
                    channel.delivered, channel.failed
                ),
                Request::Help => {
                    "!ping: pong. !stats: this channel's reply counts. !help: this message."
                        .to_owned()
                }
            };
            vec![Cmd::Reply {
                channel_id: *channel_id,
                text,
            }]
        }
        Msg::ReplyFinished { channel_id, result } => {
            let channel = next.channels.entry(*channel_id).or_default();
            match result {
                Ok(()) => {
                    channel.delivered += 1;
                    channel.last_error = None;
                }
                Err(error) => {
                    channel.failed += 1;
                    channel.last_error = Some(error.to_string());
                }
            }
            Vec::new()
        }
    };
    Step::new(next, commands)
}

pub trait ReplyClient {
    fn reply(&self, channel_id: u64, text: &str) -> impl Future<Output = Result<(), ReplyError>>;
}

struct Effects<C>(C);

impl<C: ReplyClient> Interpreter<Cmd> for Effects<C> {
    type Error = Infallible;

    fn interpret<'a>(
        &'a self,
        command: &'a Cmd,
        _: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Self::Error>> {
        Some(CommandWork::new(async move {
            let Cmd::Reply { channel_id, text } = command;
            let result = match tokio::time::timeout(
                Duration::from_secs(15),
                self.0.reply(*channel_id, text),
            )
            .await
            {
                Ok(result) => result,
                Err(error) => Err(Box::new(error) as ReplyError),
            };
            Ok(vec![Msg::ReplyFinished {
                channel_id: *channel_id,
                result,
            }])
        }))
    }
}

pub fn start(client: impl ReplyClient + 'static) -> BotRuntime {
    let machine: Machine<'static, Model, Msg, Cmd, Sub> = Machine {
        init: Box::new(|loaded, _| Step::new(loaded.unwrap_or_default(), Vec::new())),
        update: Update::reducer(update),
        subscriptions: demlik_tea::core::subscriptions(|_| Vec::new()),
    };
    let mut options: Options<Model, Msg> = Options::new(Profile::Promise);
    options.on_error = Some(Rc::new(|error, phase| {
        eprintln!("Machine runtime failure in {phase:?}: {error}");
    }));
    options.on_commit.push(Rc::new(|message, _| {
        if let Some(Msg::ReplyFinished {
            channel_id,
            result: Err(error),
        }) = message
        {
            eprintln!("Reply to channel {channel_id} failed: {error}");
        }
    }));
    launch(
        machine,
        (),
        Effects(client),
        NoSubscriptions::new(),
        options,
    )
}
