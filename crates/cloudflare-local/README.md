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
