use std::{
    cell::RefCell, collections::BTreeMap, convert::Infallible, error::Error, rc::Rc, time::Duration,
};

use demlik_tea::{
    Machine, Step, Sub, Tagged, Update,
    command::{CommandContractError, CommandFamily},
    messages,
    runtime::{
        CommandContext, CommandWork, Interpreter, NoSubscriptions, Options, Profile, Runtime,
        launch,
    },
};

use crate::cafe;

pub type ReplyError = Box<dyn Error + Send + Sync>;
pub type BotRuntime = Runtime<Model, Msg, Infallible, Infallible>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Request {
    Ping,
    Stats,
    Help,
    Cafe(cafe::Action),
    Invalid(&'static str),
}

pub fn parse_request(text: &str) -> Option<Request> {
    match text.trim() {
        "!ping" => Some(Request::Ping),
        "!stats" => Some(Request::Stats),
        "!help" => Some(Request::Help),
        _ => cafe::parse(text).map(|action| match action {
            Ok(action) => Request::Cafe(action),
            Err(usage) => Request::Invalid(usage),
        }),
    }
}

#[derive(Clone, Debug, Default)]
pub struct Channel {
    pub shop: cafe::domain::Model,
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
        CafeFinished { channel_id: u64, message: cafe::domain::Msg },
    }
}

pub enum Cmd {
    Reply {
        channel_id: u64,
        text: String,
    },
    Cafe {
        channel_id: u64,
        command: cafe::domain::Cmd,
    },
}

impl Tagged for Cmd {
    fn tag(&self) -> &str {
        match self {
            Self::Reply { .. } => "reply",
            Self::Cafe { .. } => "cafe",
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

pub fn update(model: &Model, message: &Msg) -> Step<Model, Cmd> {
    let mut next = model.clone();
    let commands = match message {
        Msg::Requested {
            channel_id,
            request,
        } => {
            let channel = next.channels.entry(*channel_id).or_default();
            channel.requested += 1;
            let mut effects = Vec::new();
            let text = match request {
                Request::Ping => "pong 🫖".to_owned(),
                Request::Stats => format!(
                    "This channel: {} delivered, {} failed. This stats reply is not counted yet.",
                    channel.delivered, channel.failed
                ),
                Request::Help => cafe::HELP.to_owned(),
                Request::Invalid(usage) => (*usage).to_owned(),
                Request::Cafe(action) => {
                    if let Some(message) = cafe::message(*action) {
                        let step = cafe::domain::update(&channel.shop, &message);
                        channel.shop = step.state;
                        effects.extend(step.commands.into_iter().map(|command| Cmd::Cafe {
                            channel_id: *channel_id,
                            command,
                        }));
                    }
                    if *action == cafe::Action::Orders {
                        cafe::orders(&channel.shop)
                    } else if matches!(action, cafe::Action::Order { .. })
                        && channel.shop.error.is_none()
                    {
                        format!(
                            "{}\n{}",
                            cafe::status(&channel.shop),
                            cafe::orders(&channel.shop)
                        )
                    } else {
                        cafe::status(&channel.shop)
                    }
                }
            };
            let mut commands = vec![Cmd::Reply {
                channel_id: *channel_id,
                text,
            }];
            commands.extend(effects);
            commands
        }
        Msg::CafeFinished {
            channel_id,
            message,
        } => {
            let Some(channel) = next.channels.get_mut(channel_id) else {
                return Step::new(next, vec![]);
            };
            if cafe::generation(message) != Some(channel.shop.generation) {
                return Step::new(next, vec![]);
            }
            let step = cafe::domain::update(&channel.shop, message);
            channel.shop = step.state;
            vec![Cmd::Reply {
                channel_id: *channel_id,
                text: cafe::status(&channel.shop),
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

struct Effects<C> {
    client: C,
    timers: RefCell<tokio::task::JoinSet<()>>,
}

impl<C: ReplyClient> Interpreter<Cmd> for Effects<C> {
    type Error = Infallible;

    fn interpret<'a>(
        &'a self,
        command: &'a Cmd,
        context: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Self::Error>> {
        if let Cmd::Cafe {
            channel_id,
            command,
        } = command
        {
            let channel_id = *channel_id;
            let command = command.clone();
            let producer = context.producer();
            return Some(CommandWork::new(async move {
                let mut timers = self.timers.borrow_mut();
                while let Some(result) = timers.try_join_next() {
                    if let Err(error) = result {
                        eprintln!("Café timer task failed: {error}");
                    }
                }
                timers.spawn_local(async move {
                    let message = cafe::perform(&command).await;
                    if let Err(error) = producer.emit(Msg::CafeFinished {
                        channel_id,
                        message,
                    }) {
                        eprintln!("Café completion could not reach channel {channel_id}: {error}");
                    }
                });
                Ok(vec![])
            }));
        }
        Some(CommandWork::new(async move {
            let Cmd::Reply { channel_id, text } = command else {
                unreachable!()
            };
            let result = match tokio::time::timeout(
                Duration::from_secs(15),
                self.client.reply(*channel_id, text),
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
        Effects {
            client,
            timers: RefCell::new(tokio::task::JoinSet::new()),
        },
        NoSubscriptions::new(),
        options,
    )
}
