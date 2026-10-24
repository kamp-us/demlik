# Run cross-language verification

Prerequisites: the repository's pinned Node/pnpm dependencies, Rust 1.99.1 with
rustfmt and clippy, and a built `@demlik/code-graph` package for full API discovery.
The implementations live beside each other in `packages/` and `crates/`.

1. Install dependencies with `pnpm install --frozen-lockfile` and `cargo fetch --locked`.
2. Run `pnpm parity` to compare the implemented operations. Results are written to
   `target/parity/report.json`; every unsupported operation or driver error fails.
3. Run `pnpm parity:mutations` to verify that deliberate behavioral regressions
   fail their intended cases. This builds disposable source copies and writes
   `target/parity/mutations.json`.
4. Run `pnpm --filter @demlik/parity typecheck` and `pnpm rust:check` to check
   TypeScript type contracts, Rust types, compile-fail examples, formatting and lint.
5. Build the reference package with `pnpm --filter @demlik/code-graph build`, then
   run `pnpm parity:complete` to check the public capability ledger as well.

`parity:complete` currently fails because the full port remains incomplete.
Passing `parity` covers only the operations listed in its report. The full check
discovers exports, nested callable declarations, wildcard exports, CLI entries and
assets, then requires a Rust mapping, an unchanged TypeScript declaration and
passing case evidence for each entry in `contracts.json`.

To use an isolated Rust installation, set `CARGO` to its cargo executable and
configure the usual `CARGO_HOME`, `RUSTUP_HOME` and `RUSTUP_TOOLCHAIN` variables.
The runner also accepts `--rust-bin <path>` and `--report <path>` for testing a
separately built binary. Generated cases use the recorded seed `0x5eed1234`.

Add shared JSON cases under `cases/`, with a unique `id`, an `operation`, `input`,
and an optional independent `expected` value. The two drivers must invoke their
real library APIs. Keep nonfinite numbers and negative zero in the explicit
`{"$number":"NaN"}`, `Infinity`, `-Infinity`, or `-0` representation. Add a new
operation in both typed drivers before claiming its behavior is covered.
