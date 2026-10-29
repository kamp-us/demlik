# Verify the delivered Actor in Chrome and local Workers

Use these private host consumers to execute the existing generic Rust Actor and
its independent Source Promise fixture in a real browser and local workerd.
Both hosts run all seven result objects and 129 logical trace entries, exact
Store strings and timer cleanup. They use a selected, already-built raw Wasm
product. No Rust runtime, Agent, Cargo or CLI edit or rebuild is required.

Prerequisites: Node 22, Python 3, the root workspace JavaScript dependencies
(including Playwright 1.62.1), system Google Chrome, wasm-bindgen CLI 0.2.129 and
this folder's pinned Wrangler 4.155.0. Set `WASM_BINDGEN` to the verified executable.
Use an owned checkout and fresh output/evidence/scratch directories.

From the repository root, first verify the fixture adaptation against the
original source revision. The original fixture body was extracted into
`source-fixture.mts`; `source.mts` is now its Node CLI wrapper. The Source library
remains frozen at `75de37ea01a81cd7949e6275b7ee9cfdeb4e312d`.

```sh
python3 crates/wasm-runtime-local/hosts/verify-source.py --source-ref b5daea4b8948d1129c7ddfe20280bda28601f7e9 --evidence target/host-source
```

This executes both the original fixture and the new wrapper, requires identical
stdout bytes and complete objects, then freezes `target/host-source/current`.
The wrapper is adapted, rather than described as an untouched fixture.

Install the locked local workerd tools in `hosts/` with npm ci. Keep its cache
and logs in this checkout's target directory:

```sh
cd crates/wasm-runtime-local/hosts
npm ci --cache ../../../target/host-npm-cache --logs-dir ../../../target/host-npm-logs --no-audit --no-fund
cd ../../..
```

Prepare new web bindings from the selected raw delivery. A gzip input also
requires its own `--gzip-sha256`; raw and gzip hashes are distinct:

```sh
python3 crates/wasm-runtime-local/hosts/prepare.py --raw-wasm /path/to/selected.wasm.gz --raw-sha256 RAW_SHA256 --gzip-sha256 GZIP_SHA256 --source-baseline target/host-source/current --output target/host-delivery
```

The selected product is decompressed and verified as a delivery input, not a
copied Cargo dependency cache. The producer records the raw product, binding
tool, generated JS/Wasm and Source bundle hashes separately. Browser bindings
are generated with `--target web`. The browser loads those bytes through the
generated asynchronous loader. The Worker imports that same generated Wasm as
a compiled WasmModule and calls `initSync({ module })` inside fetch. All actor
work and Source functions run inside that request; there is no global async I/O.

Run the real host gates, with Wrangler metrics disabled:

```sh
WRANGLER_SEND_METRICS=false python3 crates/wasm-runtime-local/hosts/prove.py --delivery target/host-delivery --source-baseline target/host-source/current --evidence target/host-proof --scratch target/host-scratch
```

Use `--host browser` or `--host worker` for a focused host. `--chrome` and
`--playwright-module` override their local paths. Chrome uses an owned profile,
loopback server and DevTools port, with Source/Rust comparisons on first use,
repeat use and a fresh page. Workerd compares first/repeated calls and a fresh
process. Both check live Actor health after workflows, original arm-error data,
clock bounds and clean timers. Raw HTTP/action outputs, browser network and
console/page errors, workerd logs, lifecycle and owned-port cleanup receipts
are retained. The runner verifies the browser's actual Wasm response hash and
read-backs of the executed Worker artifacts.

Chrome shutdown first requests CDP Browser.close, with bounded signal fallbacks
only for the owned process. Native Chrome diagnostics before/during shutdown are
retained separately. The measured host emitted native CVDisplayLink failures and
a native default web-app installation diagnostic; its page console and page
errors were empty and all Actor traces matched. This functional gate does not
claim graphics/display or general Chrome-environment acceptance.

Inspect `result.json`, each host's complete observations and cleanup records.
Actual millisecond clocks and latency samples are retained separately; no timing
or model difference is silently normalized. The timeout checks inherit the
fixture's loose lower bound. The Store is an async in-process string port, not
durable disk or SDK storage. Supplementary Effect-scope checks are minimal;
high-level Wasm Agent.run, broad Effect/SDK acceptance, cloud deployment, other
browsers, storage durability and crash recovery remain separate.

Focused static checks:

```sh
pnpm exec tsc -p crates/wasm-runtime-local/tsconfig.source.json
pnpm exec biome check crates/wasm-runtime-local/source.mts crates/wasm-runtime-local/source-fixture.mts crates/wasm-runtime-local/hosts/*.mjs
python3 -m py_compile crates/wasm-runtime-local/hosts/*.py
```
