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

This is a private snapshot adapter. It stores JSON **strings**, retains UTF-16
string cell units, preserves SDK error values, and distinguishes missing cells
from failed reads. It explicitly rejects non-UTF-8 keys and non-string cells.
The example uses only the fixed `@@state` key. Its unused transaction operation
returns typed `UnsupportedTransaction`; fenced stores and event sourcing are
outside this binding. It supplies no transaction simulation.

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
absolute alarm. It observes three real alarm callbacks in each host, checks their
ordering and deadline lower bounds, repeats the timer path, and restarts again
with an empty schedule. Callback arrival times remain separate measurements;
the gate does not claim equal clocks or scheduling latency.

The evidence directory must be fresh. It retains both executable artifacts,
producer inputs and hashes, Source bundle metadata, raw request/response streams,
logs, lifecycle records, the shared schedule, results and port cleanup receipts.
`source/` and `rust/` each own isolated persistent state. The runner never deploys,
logs in, or uses remote bindings. The snapshot adapter and Wasm Agent limitations
described above still apply.

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
