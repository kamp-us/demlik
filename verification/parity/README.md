# Run cross-language verification

Prerequisites: Node 22.21.1 (V8 12.4.254.21-node.33), the repository's pnpm dependencies, Rust 1.99.1 with
rustfmt and clippy, and a built `@demlik/code-graph` package for full API discovery.
The implementations live beside each other in `packages/` and `crates/`.

1. Install dependencies with `pnpm install --frozen-lockfile` and `cargo fetch --locked`.
2. Run `pnpm parity` to compare the implemented operations. Results are written to
   `target/parity/report.json`; every unsupported operation or driver error fails.
   Graph project discovery and semantic resolution run against shared temporary
   projects and the pinned native TypeScript compiler. Their reports are under
   `target/parity/graph-*.json`. Deliberate invalid driver inputs are counted
   separately from library behavior cases.
   Boundary ledger parsing, identity, moves and file operations compare against the
   same source API, including invalid input and UTF-16 strings. Reconciliation
   compares scope pruning, write diagnostics, acceptance and ceiling migration.
   Prepared-rule zoning traces compare both layouts, rule ownership and layout
   diagnostics. Boundary-rule input validation separately compares defaults,
   first issue paths/messages and thrown errors; declaration consistency is
   compared against the library, deployable and shape checks and the real config
   loader. Impurity vocabulary helpers cover globals, constructors and runtime
   module imports. AST impurity checks reuse OXC trees and compare global reads,
   bound names, destructuring and type positions, including real repository files.
   Wrangler catalog checks load shared JSONC/TOML files,
   manifests, binding names, environment keys and invalid configurations.
   Query traces compare reachability, unguarded paths, package interface width
   and clusters. Shared JSON traces compare exact source parse/stringify behavior
   at the data boundary, using serde and ECMAScript number formatting.
   `target/parity/paginate-queue.json` compares pure pagination, queue transitions,
   returned-reference mutation, recovery, and store failures.
   Timing checks compare debounce/throttle reentry, input transitions, restored
   data and deadline cleanup; their report is `target/parity/timing.json`.
   Runtime traces run through TypeScript Promise, TypeScript Effect, and both
   native Rust profiles. `target/parity/runtime.json` records their state,
   command, persistence and public commit order, including handler failure.
   `target/parity/runtime-contract.json` adds typed-command success, declared
   failure, defects, malformed output, undefined values and forged callbacks in
   both profiles, with complete mismatch evidence and compiled call receipts.
   `target/parity/runtime-hooks.json` compares identity filtering, per-run ports,
   callback identity, events, telemetry, timer fallback and awaited host cleanup.
   `target/parity/runtime-deadline.json` connects the deadline helper directly to
   each default timer runner and verifies remaining delay, stop and overrides.
   Promise drive cases use the public source helper; the native Effect convenience
   is not treated as a TypeScript export.
   Independent-process storage checks also run by default, with bounded child
   watchdogs. `target/parity/storage-process.json` records competing CAS writers,
   process restart, dead PID-lock recovery and deletion in both languages.
3. Run `pnpm parity:mutations` to verify that deliberate behavioral regressions
   fail their intended cases. This builds disposable source copies and writes
   `target/parity/mutations.json`, `timing-mutations.json`, `ledger-mutations.json`, `reconcile-mutations.json`, `runtime-contract-mutation.json`,
   `runtime-hooks-mutation.json`, `runtime-deadline-mutation.json`,
   `paginate-queue-mutations.json`, `zoning-mutations.json` and
   `boundary-config-mutations.json` and `boundary-domain-mutations.json`.
4. Run `pnpm --filter @demlik/parity typecheck` and `pnpm rust:check` to check
   TypeScript type contracts, Rust types, compile-fail examples, formatting and lint.
5. Build the reference package with `pnpm --filter @demlik/code-graph build`, then
   run `pnpm parity:complete` to check the public capability ledger as well.

`parity:complete` currently fails because the full port remains incomplete.
Passing `parity` covers only the operations listed in its report. The full check
discovers exports, nested callable declarations, wildcard exports, CLI entries and
assets, then requires a Rust mapping, an unchanged TypeScript declaration and
passing case evidence for each entry in `contracts.json`. Evidence must record
an actual call to the compiled public Rust path, not just a passing case name.
A mapping with a measured unresolved `knownGaps` entry still fails completion,
even when its other cases pass. Queue adapter concurrency currently has such a
qualification: native futures follow Rust polling, and arbitrary caller-level
JavaScript microtask schedules are not reproduced by a second runtime. The
library's own dispatch, persistence and awaited cleanup ordering is compared
explicitly.

The Node reference follows CI's Node 22 line. Reports record exact engine and
platform versions. Node 26 enables a different power algorithm by default and
can differ by an ULP on fractional backoff exponents; it is a separate numeric
profile, not the strict reference used here. No tolerance is applied.

To use an isolated Rust installation, set `CARGO` to its cargo executable and
configure the usual `CARGO_HOME`, `RUSTUP_HOME` and `RUSTUP_TOOLCHAIN` variables.
The runner also accepts `--rust-bin <path>` and `--report <path>` for testing a
separately built binary. Use `--runtime-bin <path>` to exercise a separately built
native runtime example, `--contract-bin <path>` for typed command contracts,
`--hooks-bin <path>` for runtime hooks, `--deadline-bin <path>` for the deadline
integration, `--paginate-queue-bin <path>` for the
pagination/queue driver, or `--timing-bin <path>` for timing. Generated cases use the recorded seed `0x5eed1234`.

Add shared JSON cases under `cases/`, with a unique `id`, an `operation`, `input`,
and an optional independent `expected` value. The two drivers must invoke their
real library APIs. Keep nonfinite numbers and negative zero in the explicit
`{"$number":"NaN"}`, `Infinity`, `-Infinity`, or `-0` representation. Add a new
operation in both typed drivers before claiming its behavior is covered.

Storage cases call the real asynchronous adapters. Memory observations retain
their loaded references until the response is serialized; explicit snapshots
are separate actions. File cases retain raw JSON/IO diagnostics in the report's
`infrastructureDiagnostics`, while comparison checks error kind/code and exact
source-owned refusal, conflict and stamp messages. JSON text inside the protocol
and explicit UTF-16 unit arrays cover strings and keys JSON.parse accepts even
when a UTF-8-only JSON value representation cannot hold them.

Run `pnpm --filter @demlik/parity verify:storage-process` after building the Rust
driver to exercise both implementations across actual child processes: six
competing CAS writers, restart reads, a verified terminated PID lock, and delete.
Results are written to `target/parity/storage-process.json`. This checks local
process restart and writer exclusion, without claiming fsync or atomic commit
of state and its separate fence stamp. Native lock probing is currently Unix;
non-Unix contention returns an explicit unsupported-process-probe error.
