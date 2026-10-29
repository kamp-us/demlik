# Run cross-language verification

Prerequisites: Node 22.21.1 (V8 12.4.254.21-node.33), the repository's pnpm dependencies, Rust 1.99.1 with
rustfmt and clippy, and a built `@demlik/code-graph` package for full API discovery.
The implementations live beside each other in `packages/` and `crates/`.
The workspace declares Rust 1.99 and pins the tested 1.99.1 toolchain.

Run each check or sequential mutation suite in its own registered Git worktree and
build in that worktree's default `target/`. Unset `CARGO_TARGET_DIR`,
`DEMLIK_MUTATION_TARGET_DIR`, `CARGO_BUILD_TARGET_DIR` and `CARGO_BUILD_BUILD_DIR`.
Keep compact reports and selected immutable baseline artifacts outside the check
worktree, restore the baseline source before each fault, and remove the finished
worktree and its build files with `git worktree remove --force`, including after a
failed check. Do not copy dependency or target caches into evidence.

For a direct mutation entry, run from `verification/parity`:

```sh
node check-worktree.mjs entry command-input-checks-run.mjs
node check-worktree.mjs entry --import tsx timestamp-mutations.mjs
```

The helper checks the actual Git registration before Cargo runs, clears all four
aliases, and records Cargo-selected executable/library hashes and diagnostics outside
the disposable checkout. Reports under `target/parity` and temporary root reports are
retained there before removal. An entry or cleanup failure remains a failure.
Graph entries also need `DEMLIK_ICU77_SOURCE_ARCHIVE` naming the official source
archive pinned by `tools/icu77/inputs.json`, and Python 3.12 or later (select with
`DEMLIK_ICU77_PYTHON` when needed). Each Graph owner builds its own ICU under its
default target; no compiled ICU tree is shared.

To replay the structural migration without running builds:

```sh
node verification/parity/tools/migrate-mutation-ownership.mjs
```

Use `--write` to apply it. A second pass must report zero changed files. The optional
`--audit-base <full-commit>` compares original fault/witness AST digests and package
Node arguments and rejects target-alias assignments or copied crate workspaces in
the aggregate's static reference closure. This inventory overapproximates reachability;
it does not prove every fault executes or remains semantically current.

For large local verification runs, use these settings to reduce compiler artifact size:

```sh
CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1 pnpm parity
```

1. Install dependencies with `pnpm install --frozen-lockfile` and `cargo fetch --locked`.
2. Run `pnpm parity` to compare the implemented operations. Results are written to
   `target/parity/report.json`; every unsupported operation or driver error fails.
   Graph project discovery and semantic resolution run against shared temporary
   projects and the pinned native TypeScript compiler. Their reports are under
   `target/parity/graph-*.json`. Deliberate invalid driver inputs are counted
   separately from library behavior cases.
   Optional analysis checks exercise every combination of kinds, reachability,
   clusters, interface width and cross-runtime reports. Backend regex failures
   retain their own wording; their category and nonempty detail are compared.
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
   Zone checks compare impurity verdicts and the test role's per-kind policy,
   including retained references. Data-site checks compare lexical binding
   aliases, method calls and SQL access heuristics. Full data reports and graph
   assembly compare binding ownership, requested empty reports and option combinations.
   Library scope checks read real manifests, package names, subpaths, nested owners,
   world packages and declaration refusals. Library verdicts also compare import
   precedence, allowed names, stale declarations, impurity and measured census lines.
   Deployable judgments compare real worker ownership, binding use, owner declarations
   and census output. Layer target checks resolve real shared files, workspace packages
   and tsconfig aliases, including measured malformed-config recovery cases.
   Layer reports compare rule input, match specificity, import classification,
   directed counts and allowance reconciliation against shared real projects.
   The layer file gate also checks config refusals, byte decoding, JSON/pretty
   rendering and exit decisions; production CLI integration is tracked separately.
   Comment checks classify real syntax
   and count lines by file, package and bucket, including source repository files.
   Comment policy checks compare ceiling validation, defaults, points, recorded
   scopes, excess and slack. The file gate compares config refusal, text/JSON
   rendering, write precedence, exit decisions and actual file bytes/modes.
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
   `target/parity/command-families.json` compares owned command names, replay,
   definition precedence and edge provenance. Raw UTF-16 tags remain a shared
   owner gap in the current native `Tagged` interface.
   `target/parity/resilient-call.json` compares composed cache, retry, circuit,
   rate and deadline decisions, restored states and the typed outcome bridge.
   Its Runtime consumer uses the actual default timer in both profiles.
   `target/parity/paginated-walk.json` compares cursor advancement, backpressure,
   callback order, retry decisions and explicit JSON reloads. The native Runtime
   consumer also runs success, retry and failure in both profiles.
   `target/parity/flow.json` compares fan-out waves, duplicate IDs, joins,
   completion ports and size/time batch windows. `target/parity/monitored-run.json`
   compares snapshot cadence, command acknowledgments, stage progress, failure,
   watchdogs and restored state. Generic serialized checkpoint payloads require
   a caller-owned decoder; typed opaque payloads run through both native profiles.
   `target/parity/workflow.json` compares owed/confirmed effects, business results,
   compensation and replay. `target/parity/saga.json` compares forward progress,
   reverse compensation, failures and restored queue state.
   `target/parity/poller.json` compares polling cadence, retries, duplicate
   detection and terminal restarts, including saved timestamp and limit values
   that become JSON null.
   `target/parity/runtime-hooks.json` compares identity filtering, per-run ports,
   callback identity, events, telemetry, timer fallback and awaited host cleanup.
   `target/parity/runtime-deadline.json` connects the deadline helper directly to
   each default timer runner and verifies remaining delay, stop and overrides.
   Promise drive cases use the public source helper; the native Effect convenience
   is not treated as a TypeScript export.
   Independent-process storage checks also run by default, with bounded child
   watchdogs. `target/parity/storage-process.json` records competing CAS writers,
   process restart, dead PID-lock recovery and deletion in both languages.
3. Mutation checks require a compiled behavioral fault to fail its intended case;
   compiler, protocol and harness errors do not count. Current component runners
   use `check-worktree.mjs` to own their worktree and default target. Package commands
   in the legacy `pnpm parity:mutations` closure enter a registered baseline owner;
   source faults use nested registered owners and their default targets. The aggregate
   has not been rerun as part of this migration. Its historical reports include
   `target/parity/mutations.json`, `timing-mutations.json`, `ledger-mutations.json`, `reconcile-mutations.json`, `runtime-contract-mutation.json`,
   `runtime-hooks-mutation.json`, `runtime-deadline-mutation.json`,
   `paginate-queue-mutations.json`, `zoning-mutations.json` and
   `boundary-config-mutations.json`, `boundary-domain-mutations.json` and
   `command-families-mutations.json`, `flow-mutation.json` and
   `monitored-run-mutation.json` and `comment-mutations.json`.
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
pagination/queue driver, `--command-families-bin <path>` for owned command names,
`--resilient-call-bin <path>` for resilient calls, `--flow-bin <path>` for flow helpers, `--monitored-run-bin <path>` for snapshot
and monitored runs, or `--timing-bin <path>` for timing.
Generated cases use the recorded seed `0x5eed1234`.

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
