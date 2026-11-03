# Connect the starter to Discord

Run these steps from `examples/rust-discord-starter`. You need the starter
source, Rust 1.99.1, and a bot you can install in a test server.

1. Open the [Discord Developer Portal](https://discord.com/developers/applications),
   create an application, and open its **Bot** settings. Obtain its bot token.
2. In the bot settings, enable **Message Content Intent**. This starter reads
   `!ping`, `!stats`, and `!help` from message content. Discord documents that
   requirement in its [gateway guide](https://docs.discord.com/developers/events/gateway#message-content-intent).
3. Use the application's installation settings to install its bot into your
   test server. Give it **View Channels** and **Send Messages** in your test
   channel. Discord's [first-bot guide](https://docs.discord.com/developers/quick-start/getting-started)
   covers application creation and installation.
4. Set the `DISCORD_TOKEN` environment variable in your terminal or IDE. Put
   the token in that environment variable, not in the Rust source.
5. Start the client:

   ```sh
   cargo run --locked --features discord -- live
   ```

6. Wait for `Connected as …`, then send `!ping` in your test channel. The bot
   should send `pong 🫖`. Send `!stats` to see that channel's counts.
7. Press **Ctrl+C** in the terminal to close the gateway and stop the machine.

The client connects outward over Discord's gateway. No public web server or
tunnel is required for this gateway adapter.

If Discord closes the gateway with code `4014`, check that Message Content
Intent is enabled for this application. If the bot receives commands but cannot
reply, check its permissions in that specific channel. The send error is
reported to the terminal and folded into the channel's failure count; a later
successful send clears its last failure summary.

This starter's state is in memory. Restarting starts a new ledger. It does not
automatically retry failed sends. A timed-out send may already have reached
Discord, so inspect the channel before repeating it.
