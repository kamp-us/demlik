# Çay Ocağı, Rust in the browser

This is the existing illustrated tea house with its Rust domain and real `demlik_tea::Machine` compiled into WebAssembly. Cloudflare serves static files. Each browser tab creates its own Wasm instance, Model, bounded Rust channel, simulation clock, and effects. There is no shared server-side simulation or account state. Reloading starts a new shift.

## Host boundary

The native demo uses `demlik_tea::runtime::launch` and Tokio timer tasks. This browser build uses the same library's **Machine core**, driven by a small browser host. It does **not** run the native Tokio actor in the browser.

Both hosts compile the same `crates/tea/examples/cay_ocagi/domain.rs`: Model, Msg, Cmd, and pure update. The browser's JavaScript only transports JSON bytes, supplies elapsed milliseconds, and renders the returned state. Rust owns the inbox, pause/speed/step state, clock, command scheduling, completion messages, and every business decision. The native adapter is kept separately in `cay_ocagi/native.rs`.

```text
UI action → Rust Msg → std::sync::mpsc inbox → Machine.update.apply
                                                    ↓
                                           new Model + Cmd
                                                    ↓
                                        browser effect adapter
                                                    ↓
                                       completion Msg → same inbox
```

The source panel's browser host, channel, effects, and shared domain excerpts are extracted from `include_str!` strings embedded **inside the Wasm binary**, with original line numbers. The Host tab identifies the actual browser implementation. Rust channels are program inboxes, not Discord chat rooms.

The whole `demlik-tea` crate compiles for `wasm32-unknown-unknown`. Two narrow portability changes were necessary: omit Tokio's native `fs` feature on Wasm, and require an explicit host timer when someone uses the Tokio runtime API on Wasm instead of referring to its cfg-excluded native default. The native target keeps its original features and fallback.

## Rebuild from the Rust repository

Use the retained `can/cay-ocagi-web` source commit, recorded in the delivered `SOURCE-COMMIT.txt`. The site delivery includes readable changed/example sources; the canonical `demlik-tea` dependency remains the repository crate, not a copied or rewritten library.

Prerequisites:

- Rust 1.99 or newer and Cargo.
- `wasm32-unknown-unknown`: `rustup target add wasm32-unknown-unknown`.
- `wasm-bindgen` CLI **0.2.129**, matching Cargo.lock.
- Node.js 22 or newer. No npm install or frontend build dependencies.
- Python 3 only for the optional local preview server.

Use the official prebuilt CLI for your platform from the [wasm-bindgen 0.2.129 release](https://github.com/wasm-bindgen/wasm-bindgen/releases/tag/0.2.129). The macOS arm64 archive used here is `wasm-bindgen-0.2.129-aarch64-apple-darwin.tar.gz`; its published SHA-256 is `81d4a23d56b3c3eb8187658329116d50e0b228a93b343825fb71f70179051cd1`. Put its executable on PATH, or set `WASM_BINDGEN` to its absolute path. If building the tool instead, keep its build in the checkout's target directory:

```sh
cargo install wasm-bindgen-cli --version 0.2.129 --locked \
  --root "$PWD/.tools" --target-dir "$PWD/target"
export WASM_BINDGEN="$PWD/.tools/bin/wasm-bindgen"
```

From a checkout of the Rust repository:

```sh
unset CARGO_TARGET_DIR DEMLIK_MUTATION_TARGET_DIR CARGO_BUILD_TARGET_DIR CARGO_BUILD_BUILD_DIR
cargo build -p cay-ocagi-web --lib --target wasm32-unknown-unknown --release
node crates/cay-ocagi-web/build-site.mjs ./dist
python3 -m http.server 4320 --bind 127.0.0.1 --directory ./dist
```

Open `http://127.0.0.1:4320`. The site output consists of six files: `index.html`, `style.css`, `app.js`, `wasm-host.js`, `cay_ocagi_web.js`, and `cay_ocagi_web_bg.wasm`. Deploy that directory as static assets. The generated wasm-bindgen loader is used as generated; no fabricated Wasm imports are supplied. Browser initialization currently needs its one generated externref-table initializer import.

The build script writes only its requested output directory and the current checkout's `target/cay-web` generated bindings. It does not register, publish, or configure a Site.

## Bounded verification

```sh
cargo check -p demlik-tea --target wasm32-unknown-unknown
cargo test -p demlik-tea --example cay_ocagi
cargo build -p cay-ocagi-web --bin native_trace
node crates/cay-ocagi-web/verify.mjs
```

`verify.mjs` requires the Wasm build/postprocessing above. It compares **every complete Model and Cmd list** for 31 identical Msg values compiled natively and to Wasm: three-table service, empty-water failure/recovery, invalid timing, cancellation, reset, and stale completions. This is bounded equivalence for those traces, not a claim of universal parity.

It also drives the actual Wasm browser adapter through paused inbox/step, concurrent ordering while heating, three tables receiving six glasses with conserved inventory, failure/refill/retry, input validation, embedded-source extraction, and isolation between two independent Wasm instances. Actual browser interaction remains a separate check from these programmatic checks.
