# Verify the generic Actor runtime on Node and Wasm

Use this private consumer to exercise `runtime::try_launch`, dispatch/ready/stop
receipts and `drive_to_done` in real compiled Rust Wasm. It uses the existing
Actor, queues, cancellation, listeners, work kinds and Store ports. It does not
run a second reducer loop or launch high-level Agent `.run`.

Prerequisites: the repository Rust toolchain with `wasm32-unknown-unknown`, Node
22, Python 3, root workspace JavaScript dependencies, and wasm-bindgen CLI
0.2.129 matching Cargo.lock. Set `WASM_BINDGEN` to that executable. Keep Cargo's
four target aliases unset and build in this checkout's default target directory.

From the repository root, freeze the unchanged Source Promise reference before
editing Rust semantics:

```sh
python3 crates/wasm-runtime-local/prove.py --source-only --evidence target/wasm-source-before
```

Then build the actual consumer and its generated Node loader:

```sh
cargo build --locked -p demlik-wasm-runtime-local --target wasm32-unknown-unknown --release
"$WASM_BINDGEN" target/wasm32-unknown-unknown/release/demlik_wasm_runtime_local.wasm --target nodejs --out-dir target/wasm-node --out-name runtime
python3 crates/wasm-runtime-local/prove.py --package target/wasm-node --source-baseline target/wasm-source-before --evidence target/wasm-node-proof
```

Each evidence directory must be fresh. Inspect `result.json`, the raw stdout and
stderr streams, producer inputs and hashes, and the copied executable Node
loader/Wasm. The gate verifies that Source inputs still match the frozen hashes
and library reference `75de37ea01a81cd7949e6275b7ee9cfdeb4e312d`.

The two isolated actors restore different counter seeds and exercise asynchronous
command Promise work, tracked detached work, builtin timer cancellation and
firing, listener/observer/boot subscriptions and unsubscribe, ready/dispatch
receipts, and stop. Additional cases compare original Store save errors, failed
load refusal, drive-to-terminal, bounded drain with queued/late completion, and
bounded async subscription disposal. The complete logical traces, models,
reports and exact Store JSON strings match the independent Source execution.
The Store is an asynchronous in-process string port, not durable disk storage.
Source's detached work uses its existing internal `detachWorkOf` seam.

Inspect `host_seams` for Rust-only host checks: a dropped stop waiter retains
teardown ownership, a completed drain clears its pending deadline, and failed
deadline arms preserve their original TimerError data on both teardown waits.
Arm failures report at discard and resolve stop without falsely reporting an
elapsed timeout. A minimal generic Effect scope also closes after a zero-delay
builtin timer source. An asynchronous telemetry sink exercises owned work and the
Actor's default Date.now clock. `--host-seams-only` runs just these probes for a focused
compiled fault control.

This consumer's Timer adapter calls actual Node/global `setTimeout` and
`clearTimeout`; no simulated clock advances it. Native runtime hosts retain the
Tokio executor, SystemTime clock and Tokio timeouts. Wasm uses the JavaScript
microtask executor, a Date.now default clock, and requires an injected
`Options.timer`. Teardown deadlines own their cancelers and chunk long waits
through the same timer seam. Ready waits need no deadline arm.

The proof compares logical ordering, not equal clock readings or exact latency.
The 15ms timeout checks use a loose lower bound; the default clock is separately
checked against the subprocess's epoch bounds. Actual browser and Workers
profiles remain separate acceptance work, as does high-level Wasm Agent `.run`.

Focused checks:

```sh
cargo fmt --check -p demlik-tea -p demlik-wasm-runtime-local
cargo check --locked -p demlik-wasm-runtime-local
cargo clippy --locked -p demlik-wasm-runtime-local --target wasm32-unknown-unknown -- -D warnings
pnpm exec biome check crates/wasm-runtime-local/source.mts crates/wasm-runtime-local/source-smoke.mts crates/wasm-runtime-local/probe.mjs
pnpm exec tsc -p crates/wasm-runtime-local/tsconfig.source.json
python3 -m py_compile crates/wasm-runtime-local/prove.py
```

For separate actual browser and local Workers acceptance using the same delivered
raw Wasm product, follow [the host delivery checks](hosts/README.md).
