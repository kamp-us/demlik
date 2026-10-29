# Verify the local Durable Object host

Build and run this private consumer to check real local SDK storage and alarm
callbacks around the existing scheduled-job Machine. It uses `Machine`, basic
unfenced `do_store`, and `durable_timer`, with a borrowed `Rc` model inside each
callback. It does not launch the native Tokio runtime.

Prerequisites: the repository Rust toolchain, `wasm32-unknown-unknown`, Node 22,
Python 3, and `worker-build` 0.8.7 on PATH. Cargo resolves `worker` exactly 0.8.7;
the isolated npm lock pins Wrangler 4.155.0. Run these commands from this folder,
with all four target aliases unset (`CARGO_TARGET_DIR`,
`DEMLIK_MUTATION_TARGET_DIR`, `CARGO_BUILD_TARGET_DIR`, `CARGO_BUILD_BUILD_DIR`).

```sh
npm ci --ignore-scripts --no-audit --no-fund
cargo check --locked --target wasm32-unknown-unknown
worker-build --release --locked
WRANGLER_SEND_METRICS=false python3 prove-local.py --evidence ../../target/cloudflare-local-proof
```

Choose a fresh evidence directory for each run. The runner starts local Wrangler
on a free loopback port, seeds three fixed future jobs, stops and restarts against
the same persisted directory, then observes three actual SDK alarm callbacks and
all intermediate saved states. It checks a repeated callback, a second restart,
exact completion IDs, the JSON string storage cell, and an empty final schedule.
It records requests, responses, process lifecycle, Wrangler logs and results, and
stops its own processes in cleanup. The generated proof config references the
already built Wasm and deliberately has no build hook, preventing hot reload
from rebuilding code during the restart experiment.

Inspect `result.json`, `requests.jsonl`, and the three `wrangler-*.log` files.
`/repeat` is a local proof endpoint calling the same timer path, not a forced SDK
redelivery. The real callbacks appear as `origin: "alarm"` in the logs.

This private SDK adapter supports UTF-8 keys and scalar cells (undefined,
null, booleans, numbers and UTF-16 strings), including the numeric fence cells
used by `do_store_with(...).fenced()`. `list(prefix)` queries the SDK with a
prefix. Array/object cells and other structured-clone profiles, non-UTF-8 keys,
and nested transactions return explicit typed refusals. It preserves original
SDK errors and distinguishes missing cells from failed reads.

Transactions use real SDK `Storage.transaction`. Worker 0.8.7 requires its
callback/future to be static and return unit; TEA allows borrowed arbitrary body
results and errors. Owned one-shot channels lend the real transaction handle to
the caller's future, which polls its borrowed body locally and retains its result
until SDK settlement. No `static`, `Send`, `Sync`, `Clone`, `Debug` or serialization
bound is added to the generic library contract. A body error requests rollback;
early SDK and commit errors return `TransactionError::Storage`, retaining the
original SDK value. A body error returns `TransactionError::Body` after a
successful rollback. If rollback itself fails, the SDK failure takes precedence.

Dropping the native future before its commit decision closes the owned channel
and requests SDK rollback. The detached SDK future retains its callback until
settlement and never captures borrowed domain data. Once the commit decision has
been sent, dropping the awaiting caller cannot revoke that decision. This is
native cancellation behavior; dropping an eager JavaScript Promise does not
cancel its transaction. The existing SQLite-backed class is unchanged. These
checks exercise its asynchronous key-value transaction API, not SQL statements.

The high-level Agent `.run` remains native-only because it uses Tokio's LocalSet
and timer. Portable Agent `.machine` remains available for custom Wasm hosts;
this example does not establish full Wasm Agent execution parity.

The resulting proof covers local process restart, workerd alarms and persisted
storage. It does not establish cloud scheduling, forced alarm retry timing,
automatic idle eviction, a paired TypeScript SDK host, or broad cross-cloud
parity. No account, deployment or remote binding is required.

## Compare the frozen Source and Rust hosts

After the same build, run the paired gate from this folder:

```sh
WRANGLER_SEND_METRICS=false python3 prove-paired.py --evidence ../../target/cloudflare-paired-proof
```

The workspace dependencies must also be installed (`pnpm install --frozen-lockfile`
from the repository root). `source.ts` imports the unchanged TypeScript TEA library,
guarded against reference `75de37ea01a81cd7949e6275b7ee9cfdeb4e312d`. Its
scheduled-job reducer has the same transitions as the generic durable-alarm
fixture. Both hosts use actual SDK storage and alarms, in separate local workerd
servers using the same pinned Wrangler installation. No in-memory storage or
timer substitute participates.

The gate persists one explicit three-job absolute schedule in both objects,
rejects invalid schedules without changing storage, recovers before the first
deadline, and compares every settled model, exact JSON string cell, and chosen
absolute alarm. Body-bearing repeat requests are followed by a live health
request and checked for uncaught runtime errors before shutdown. It observes
three real alarm callbacks in each host, checks their
ordering and deadline lower bounds, repeats the timer path, and restarts again
with an empty schedule. Callback arrival times remain separate measurements;
the gate does not claim equal clocks or scheduling latency.

For the fast real-HTTP repeat regression without waiting for alarms:

```sh
WRANGLER_SEND_METRICS=false python3 prove-paired.py --repeat-only --evidence ../../target/cloudflare-repeat-proof
```

This sends three JSON-body repeat POSTs per host and checks live health and the
specific unread-request-stream exception. Both consumers drain the ignored
repeat body before returning a response. Runtime diagnostics captured before
stop are separate from diagnostics emitted during stop; the normal owned
SIGINT shutdown exit code is 130. Inspect each host's `runtime-checks.json`.

The evidence directory must be fresh. It retains both executable artifacts,
producer inputs and hashes, Source bundle metadata, raw request/response streams,
logs, lifecycle records, the shared schedule, results and port cleanup receipts.
`source/` and `rust/` each own isolated persistent state. The runner never deploys,
logs in, or uses remote bindings. The scalar storage profile and Wasm Agent
limitations described above still apply.

`POST /seed` accepts `{ "jobs": [epochMs1, epochMs2, epochMs3] }`: three strictly
increasing future integer millisecond deadlines in the JavaScript Date range.
Rust also retains its original empty-body seed for `prove-local.py`.

Focused static checks from the repository root:

```sh
cargo fmt --check -p demlik-cloudflare-local
pnpm exec biome check crates/cloudflare-local/source.ts
pnpm exec tsc -p crates/cloudflare-local/tsconfig.source.json
python3 -m py_compile crates/cloudflare-local/prove-paired.py
```

## Verify borrowed transactions and fenced snapshots

After the same build, run the fast actual-SDK gate:

```sh
WRANGLER_SEND_METRICS=false python3 prove-transactions.py --evidence ../../target/cloudflare-transactions-proof
```

`transactions.ts` uses the frozen Source library's `doStore` with fencing and the
real JavaScript `Storage.transaction`. The Rust consumer uses the unchanged
native `DurableObjectStorage` and `Fencing` interfaces. The gate compares exact
cells and results across commit, a two-write/delete rollback, an original rich
borrowed body error, a borrowed result, a real SDK error after rollback, and a
stale fenced writer. The paired fenced-store `delete()` removes its snapshot and
version cells, resets a fresh read to null/version zero, and refuses the former
version-one owner. It also checks transactional prefix queries, scalar types
including a lone UTF-16 surrogate, deletion, invalid commands, persistent process
restart, and repeat-body health. Rust-only probes check explicit unsupported
profiles and safe cancellation before the SDK callback and during the body.

Two local fault controls exercise SDK error forwarding: `sdk-reject` rejects the
SDK transaction method before the callback, and `commit-reject` wraps the real
method and throws after the body succeeds, causing the real backend to roll back.
They verify original error identity and whether the body ran. They model those
failure locations; they do not simulate a remote disk failure. Real runtime errors
fail the gate even when state comparisons pass. A 2049-character key was accepted
by local workerd, so this proof does not claim remote key-size-limit enforcement.

Use `--source-only` to verify the Source reference before a Rust change,
`--source-freeze /path/to/manifest.json` to enforce previously frozen consumer
hashes, or `--stop-after rollback` (also `commit-reject`, `cancel`, etc.) for a
focused regression. The full gate takes seconds and has no alarm wait. Producer
inputs, executable Source/Wasm, hashes, HTTP records, logs, runtime checks and
owned-port cleanup are retained in each fresh evidence directory. An initial
unsupported-adapter red and targeted transaction-fault mutations establish that
the gate detects the missing capability and rollback/settlement regressions.

The checks are local to Wrangler 4.155.0, worker 0.8.7 and SQLite-backed workerd.
They establish this fenced snapshot workflow. They do not establish arbitrary
structured-clone storage, event-sourced runtime acceptance, KV-backend retries,
remote failure recovery or deployed behavior.
