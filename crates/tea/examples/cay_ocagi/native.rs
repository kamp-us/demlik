use super::domain::*;
use demlik_tea::Tagged;
use demlik_tea::runtime::{CommandContext, CommandWork, Interpreter};
use serde::Serialize;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Serialize)]
pub struct ActiveEffect {
    pub id: u64,
    pub command: Cmd,
    pub start: f64,
    pub duration: f64,
}
#[derive(Default)]
pub struct Clock {
    pub now: f64,
    pub paused: bool,
    pub speed: f64,
    pub steps: u32,
}
pub type Trace = Arc<Mutex<super::View>>;
#[derive(Clone)]
pub struct Effects {
    pub clock: Arc<Mutex<Clock>>,
    pub view: Trace,
    pub inbox: std::sync::mpsc::SyncSender<super::Envelope>,
}

// @section effects
// The native interpreter starts a timer task, then immediately accepts more work.
// This local task belongs to the app's Tokio LocalSet; stopping the app drops it.
impl Interpreter<Cmd> for Effects {
    type Error = Infallible;
    fn interpret<'a>(
        &'a self,
        command: &'a Cmd,
        _: CommandContext<Msg, Self::Error>,
    ) -> Option<CommandWork<'a, Vec<Msg>, Self::Error>> {
        let effects = self.clone();
        let command = command.clone();
        Some(CommandWork::new(async move {
            tokio::task::spawn_local(async move {
                effects.perform(command).await;
            });
            Ok(vec![]) // The eventual result comes back through the channel.
        }))
    }
}

impl Effects {
    async fn perform(&self, command: Cmd) {
        let duration = match &command {
            Cmd::HeatWater { .. } => 6.0,
            Cmd::SteepTea { .. } => 8.0,
            Cmd::DeliverTea { .. } => 2.5,
        };
        let start = self.clock.lock().unwrap().now;
        let id = {
            let mut view = self.view.lock().unwrap();
            view.effect_id += 1;
            let id = view.effect_id;
            view.effects.push(ActiveEffect {
                id,
                command: command.clone(),
                start,
                duration,
            });
            view.event(
                "effect",
                command.tag(),
                serde_json::to_value(&command).unwrap(),
                None,
            );
            id
        };
        while self.clock.lock().unwrap().now - start < duration {
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        let completion = match command {
            Cmd::HeatWater {
                generation,
                has_water,
            } => Msg::HeatFinished {
                generation,
                result: if has_water {
                    Ok(())
                } else {
                    Err("Semaverde su yok. Su ekleyip ateşi yeniden yak.".into())
                },
            },
            Cmd::SteepTea {
                generation,
                glasses,
            } => Msg::BrewFinished {
                generation,
                glasses,
            },
            Cmd::DeliverTea { generation, id } => Msg::ServeFinished { generation, id },
        };
        // A completion is a ticket too. A paused inbox retains it until resumed.
        loop {
            match super::enqueue(completion.clone(), &self.inbox, &self.view) {
                Ok(_) => break,
                Err(std::sync::mpsc::TrySendError::Full(_)) => {
                    // Preserve the result while the bounded inbox is full.
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
                Err(std::sync::mpsc::TrySendError::Disconnected(_)) => {
                    eprintln!("Tea-house inbox disconnected before completion: {completion:?}");
                    break;
                }
            }
        }
        self.view
            .lock()
            .unwrap()
            .effects
            .retain(|effect| effect.id != id);
    }
}
// @endsection
