# Your first Rust TEA bot

Run a machine, watch its state change, then connect that same machine to Discord.
Use Rust 1.99.1 and this source checkout or the delivered source bundle.

For the multiplayer tea-house simulation, follow [Run a Discord çay ocağı](docs/cafe.md).
Use `cafe-demo` for its offline journey; `!help` lists its live commands.

## 1. Run it locally

From the repository or unpacked bundle:

```sh
cd examples/rust-discord-starter
cargo run --locked -- demo
```

This uses the real Rust TEA runtime with a simulated network. It sends pings in
three channels, deliberately fails one reply, recovers on the next ping, and
prints each channel's counts.

The final state is:

```text
channel 17: 2 delivered, 0 failed
channel 29: 3 delivered, 1 failed
channel 43: 2 delivered, 0 failed
```

The line saying **INTENTIONAL DEMO FAILURE** is part of the lesson. It is not a
failure to connect your bot. Demo mode needs no token or Discord account.

## 2. Follow one ping

Think of the machine as a ledger with an inbox. The SDK delivers a ticket to
the inbox; the machine updates its ledger and hands the host a work order.

```text
!ping
  → Requested message
  → pure update function
  → Reply command
  → async ReplyClient
  → ReplyFinished message
  → updated channel counts
```

Open [src/bot.rs](src/bot.rs). These are the pieces to edit:

| Rust name | What it does |
| --- | --- |
| `Model` | Holds each channel's reply counts and last failure summary. |
| `Msg` | Describes a request or a completed reply. |
| `update` | Returns new state and commands, without network calls. |
| `Cmd` | Describes a reply to send. |
| `ReplyClient` | Performs the actual async send. |

The ping branch is:

```rust
Request::Ping => "pong 🫖".to_owned(),
```

The interpreter later waits for the send:

```rust
self.0.reply(*channel_id, text)
```

Its result becomes a `ReplyFinished` message. The error remains an owned error
value in that message. The model stores a display summary.

## 3. Change the machine

Change `"pong 🫖"` to your own reply in `src/bot.rs`, then run the demo again:

```sh
cargo run --locked -- demo
```

The demo and real Discord adapter use this same update function. The runtime
starts inside a Tokio `LocalSet`, which keeps the machine's work together.
SDK callbacks can run elsewhere and send messages through its `Producer`.

## 4. Connect your bot

Follow [Connect to Discord](docs/discord.md). Live mode uses the real
[Serenity 0.12.5 SDK](https://docs.rs/serenity/0.12.5/serenity/).

For more context, read [How the starter is put together](docs/machine.md).
