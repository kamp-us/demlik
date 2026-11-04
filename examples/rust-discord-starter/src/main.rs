use std::{env, io};

use demlik_discord_starter::{bot::ReplyError, demo};

const HELP: &str = "\
Rust TEA Discord starter

  cargo run --locked -- demo\n  cargo run --locked -- cafe-demo
  cargo run --locked --features discord -- live

demo and cafe-demo run locally without credentials or network calls.
live connects a real bot using DISCORD_TOKEN. See docs/discord.md.
";

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("Error: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), ReplyError> {
    let mut arguments = env::args().skip(1);
    let mode = arguments.next().unwrap_or_else(|| "demo".to_owned());
    if arguments.next().is_some() {
        return Err(io::Error::other("expected one mode: demo, cafe-demo, live, or help").into());
    }
    match mode.as_str() {
        "demo" => {
            tokio::task::LocalSet::new()
                .run_until(async {
                    let report = demo::run().await?;
                    println!("Final machine state:");
                    for (id, channel) in &report.state.channels {
                        println!(
                            "  channel {id}: {} delivered, {} failed",
                            channel.delivered, channel.failed
                        );
                    }
                    Ok(())
                })
                .await
        }
        "cafe-demo" => {
            tokio::task::LocalSet::new()
                .run_until(async {
                    let report = demo::cafe_run().await?;
                    let shop = &report.state.channels[&17].shop;
                    println!(
                        "Final café: {} glasses served, {} water, {} leaves, {} ready.",
                        shop.served, shop.water, shop.leaves, shop.tea
                    );
                    Ok(())
                })
                .await
        }
        "live" => run_live().await,
        "help" | "--help" | "-h" => {
            print!("{HELP}");
            Ok(())
        }
        _ => Err(io::Error::other("unknown mode; use demo, cafe-demo, live, or help").into()),
    }
}

#[cfg(feature = "discord")]
async fn run_live() -> Result<(), ReplyError> {
    let config = demlik_discord_starter::discord::Config::from_env()?;
    tokio::task::LocalSet::new()
        .run_until(demlik_discord_starter::discord::run(config))
        .await
}

#[cfg(not(feature = "discord"))]
async fn run_live() -> Result<(), ReplyError> {
    Err(io::Error::other("live mode needs: cargo run --locked --features discord -- live").into())
}
