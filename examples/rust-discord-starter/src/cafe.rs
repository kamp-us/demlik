//! Discord's view of the same domain used by the browser and native tea-house demos.
#[path = "../../../crates/tea/examples/cay_ocagi/domain.rs"]
pub mod domain;

use domain::{Cmd, Model, Msg, OrderStatus};
use std::time::Duration;

pub const HELP: &str = "🫖 Çay ocağı: everyone in this channel shares one shop.\n\
!cay <table 1-3> [glasses 1-6] · !heat · !brew · !serve <order-id>\n\
!orders · !status · !cancel <order-id> · !water · !leaves\n\
!empty (failure experiment) · !reset (new shift)\n\
Example: !cay 1 2 → !heat → wait → !brew → wait → !serve 1\n\
Heating takes 6s, brewing 8s, serving 2.5s. The bot announces completions.\n\
State is in memory: restarting the bot starts fresh shops. !ping and !stats still work.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Order { table: u8, glasses: u8 },
    Heat,
    Brew,
    Serve { id: u32 },
    Cancel { id: u32 },
    Water,
    Leaves,
    Empty,
    Reset,
    Status,
    Orders,
}

pub fn parse(text: &str) -> Option<Result<Action, &'static str>> {
    let mut words = text.split_whitespace();
    let command = words.next()?;
    let args: Vec<_> = words.collect();
    let action = match command {
        "!cay" | "!çay" => {
            let table = args.first().copied().unwrap_or("1").parse::<u8>();
            let glasses = args.get(1).copied().unwrap_or("1").parse::<u8>();
            match (table, glasses) {
                (Ok(table @ 1..=3), Ok(glasses @ 1..=6)) if args.len() <= 2 => {
                    Ok(Action::Order { table, glasses })
                }
                _ => Err("Usage: !cay <table 1-3> [glasses 1-6]. Example: !cay 1 2"),
            }
        }
        "!serve" | "!cancel" => match args.as_slice() {
            [id] => match id.parse::<u32>() {
                Ok(id) if id > 0 => Ok(if command == "!serve" {
                    Action::Serve { id }
                } else {
                    Action::Cancel { id }
                }),
                _ => Err("Use a positive order ID from !orders: !serve 1 or !cancel 1"),
            },
            _ => Err("Use an order ID from !orders: !serve 1 or !cancel 1"),
        },
        "!heat" => no_args(&args, Action::Heat),
        "!brew" => no_args(&args, Action::Brew),
        "!water" => no_args(&args, Action::Water),
        "!leaves" => no_args(&args, Action::Leaves),
        "!empty" => no_args(&args, Action::Empty),
        "!reset" => no_args(&args, Action::Reset),
        "!status" => no_args(&args, Action::Status),
        "!orders" => no_args(&args, Action::Orders),
        _ => return None,
    };
    Some(action)
}

fn no_args(args: &[&str], action: Action) -> Result<Action, &'static str> {
    if args.is_empty() {
        Ok(action)
    } else {
        Err("That command takes no arguments. Use !help for the command list.")
    }
}

pub fn message(action: Action) -> Option<Msg> {
    Some(match action {
        Action::Order { table, glasses } => Msg::OrderPlaced { table, glasses },
        Action::Heat => Msg::HeatRequested,
        Action::Brew => Msg::BrewRequested,
        Action::Serve { id } => Msg::ServeRequested { id },
        Action::Cancel { id } => Msg::OrderCancelled { id },
        Action::Water => Msg::WaterRefilled,
        Action::Leaves => Msg::LeavesRestocked,
        Action::Empty => Msg::WaterEmptied,
        Action::Reset => Msg::ResetRequested,
        Action::Status | Action::Orders => return None,
    })
}

pub fn status(model: &Model) -> String {
    format!(
        "🫖 {:?} · water {} · leaves {} · ready {} glasses · served {}\n{}{}",
        model.phase,
        model.water,
        model.leaves,
        model.tea,
        model.served,
        model.note,
        model
            .error
            .as_ref()
            .map(|e| format!("\n⚠️ {e}"))
            .unwrap_or_default()
    )
}

pub fn orders(model: &Model) -> String {
    if model.orders.is_empty() {
        return "No orders yet. Try !cay 1 2".into();
    }
    let mut lines = vec!["🧾 Most recent orders (up to 12):".to_owned()];
    for order in model.orders.iter().rev().take(12) {
        let state = match order.status {
            OrderStatus::Waiting => "waiting",
            OrderStatus::Serving => "on the tray",
            OrderStatus::Served => "served",
            OrderStatus::Cancelled => "cancelled",
        };
        lines.push(format!(
            "#{} · table {} · {} glasses · {state}",
            order.id, order.table, order.glasses
        ));
    }
    lines.join("\n")
}

pub fn generation(message: &Msg) -> Option<u64> {
    match message {
        Msg::HeatFinished { generation, .. }
        | Msg::BrewFinished { generation, .. }
        | Msg::ServeFinished { generation, .. } => Some(*generation),
        _ => None,
    }
}

pub async fn perform(command: &Cmd) -> Msg {
    let duration = match command {
        Cmd::HeatWater { .. } => Duration::from_secs(6),
        Cmd::SteepTea { .. } => Duration::from_secs(8),
        Cmd::DeliverTea { .. } => Duration::from_millis(2500),
    };
    tokio::time::sleep(duration).await;
    match *command {
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
    }
}
