# Demlik in Rust

The Rust port is a sibling of the TypeScript implementation. It runs native
Rust machines with state, messages, commands, subscriptions, async effects,
and persistence facilities. It is an experimental preview, with measured
behavioral comparisons, rather than a completed full-parity release.

Start with [Your first Rust TEA bot](examples/rust-discord-starter/README.md).
That standalone application uses the public `demlik-tea` interface. Its default
demo runs without Discord credentials. Its optional real Discord adapter uses
Serenity.

The other Rust library, `demlik-code-graph`, analyzes source and provides CLI
reports. It is separate from the machine runtime and is not needed by this bot.

The interactive çay ocağı examples demonstrate the same state/message/command
ideas through a tea-house simulation. Their source is under
`crates/tea/examples/cay_ocagi`, `crates/cay-ocagi-web`, and
`crates/cay-ocagi-gpui`.

Advanced child Agent composition, full decoded-snapshot Agent recovery, the
remaining high-level browser/Cloudflare Agent delivery checks, and the broad
verification/platform matrix are deferred. Those gaps do not prevent the
tested native machine starter from running.
