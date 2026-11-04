# Run a Discord çay ocağı

One channel is one shared shop. You and your brother can take turns typing these
commands. Other channels have separate shops. The same Rust domain source powers
this bot and the illustrated/GPUI tea-house demos; their running states are separate.

## Serve the first order

Start the bot with `Start Discord.command` in the Desktop starter folder, or run:

```sh
cd examples/rust-discord-starter
cargo run --locked --features discord -- live
```

Keep that Terminal open. Use `!help` in a channel the bot can read and reply to.

1. Send `!cay 1 2`: table1 orders two glasses; note its order ID.
2. Send `!heat`. The bot acknowledges immediately, then announces hot water after6s.
3. While it heats, your brother can send `!cay 2 2` in the same channel.
4. After the completion, send `!brew`. After8s, six glasses are ready.
5. Send `!orders`, then `!serve 1` and `!serve 2`. Each delivery takes2.5s.
6. Send `!status` to inspect stock and the served count.

Try `!brew` before heating to see a refusal. Try `!reset`, `!empty`, then `!heat`
to see an empty-water failure. Recover with `!water` and `!heat`. Resetting during
heating/brewing starts a new shift; old timer completions are ignored.

`!cancel <id>` cancels a waiting order. `!leaves` restocks leaves. `!reset` affects
the shared shop in that channel. Everyone with access to that channel can run
these simulation controls, so choose a channel where that is welcome.

## Run without Discord

```sh
cargo run --locked -- cafe-demo
```

This uses the real runtime and timers, prints replies locally, and serves six
glasses to three tables. It needs no credentials or network calls. On the Mac
starter, double-click `Run Cafe Demo.command` for the same journey.

Closing Terminal stops the bot. Restarting creates fresh in-memory shops. The
website is a separate per-page simulation; there is no shared website/Discord
backend, persistent café storage or 24/7 hosting in this example.

## Follow one request in source

```text
Discord !heat → parse_request → Requested(Cafe(Heat))
  → pure shop update → HeatWater command
  → detached Tokio timer (the inbox keeps accepting orders)
  → CafeFinished(HeatFinished) → shop update → Discord reply
```

The Discord SDK only forwards recognized, validated text requests; bot-authored
messages and ordinary conversation are ignored. `cafe.rs` translates requests,
formats replies and runs simulation timers. `bot.rs` owns the channel map and
runtime effects. The actual shop rules come directly from
`crates/tea/examples/cay_ocagi/domain.rs`, without a copy or a rewrite.

Discord HTTP failures remain owned SDK errors, are recorded in the channel's
reply statistics and printed locally. They do not rewind a shop transition or
retry a customer's order. `!stats` reports delivery counts; `!status` reports the
shop. All effects here simulate tea, not physical equipment.
