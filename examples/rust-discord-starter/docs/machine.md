# How the starter is put together

The bot has one machine and two ways of sending replies. The machine owns the
ledger and decisions. Its host owns the connection and network work.

`bot.rs` defines ordinary Rust data: a model, request variants, completion
messages, and reply commands. The `messages!` macro supplies message tags.
The exhaustive `match` in `update` is where application rules live.

`demo.rs` provides an offline `ReplyClient`. `discord.rs` provides a
`ReplyClient` backed by Serenity and an event handler that sends recognized
requests into the runtime. Bot-authored messages and unrelated text are ignored.
The SDK owns the gateway protocol, heartbeats, and reconnection.

The Tokio `LocalSet` owns the local TEA runtime. Serenity's callbacks need
`Send` futures; they hold the smaller `Producer<Msg>` handle rather than the
runtime itself. That handle is the inbox entrance.

Both adapters run the same machine. Replies happen asynchronously outside the
pure update function. Each result returns through the inbox, so a failed HTTP
request can update state without terminating the whole bot.

Stats are per channel. A stats message describes counts at the time the machine
handles that request, before counting the delivery of the stats reply itself.
State is in memory and is reset on restart.

This example uses `demlik-tea` as an independent Cargo dependency. It does not
need Node, TypeScript, code-graph, browser Wasm, or an LLM provider.
