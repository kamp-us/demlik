# Çay Ocağı · GPUI browser variant

A real GPUI canvas beside a read-only Rust source panel. GPUI renders the shop,
handles clicks and keyboard input, and supplies elapsed time to the existing
`cay_ocagi_web::BrowserHost`. That host owns the actual `demlik_tea::Machine`,
Model, bounded Rust message channel and effect clock. The domain and host are
path dependencies, not copies. Each loaded page has its own host.

This is a standalone nested Cargo workspace. Its graphics dependencies and lock
file do not enter the normal TEA/codegraph workspace builds.

## Run

From this package directory, with Rust 1.99 or newer and Node installed:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
unset CARGO_TARGET_DIR DEMLIK_MUTATION_TARGET_DIR CARGO_BUILD_TARGET_DIR CARGO_BUILD_BUILD_DIR
cargo build --locked --release --target wasm32-unknown-unknown
node build-site.mjs
python3 -m http.server 4321 --bind 127.0.0.1 --directory dist
```

Open http://127.0.0.1:4321. `WASM_BINDGEN=/path/to/wasm-bindgen` can select an
already installed matching CLI. The build script accepts an optional destination
path. Its URLs are relative, so the static files also work under `/gpui/`.
The optional `<!--cay-variants-->` marker is for the hosting layer's navigation.

GPUI is pinned to official Zed revision
`02d47bf64fcece0edc5b849d25e3a60a67d01c83`, using
`gpui_platform::single_threaded_web()` with default features disabled. This
profile works on stable Rust without SharedArrayBuffer or cross-origin isolation
headers. The upstream web backend uses WebGPU or WebGL2; hardware/browser
support remains necessary. The first build fetches and compiles GPUI's graphics
dependencies. Subsequent view-only builds reuse this package's default `target/`.

## Try one journey

1. Click **Duraklat**, then **Kemal amca**. The Rust inbox has one message while
   the order ledger is still empty. **Tek adım** processes that message.
2. Resume; add Elif and Deniz orders. Heat, wait for hot water, then brew.
3. Deliver each order. Six glasses move through the actual domain transitions.
4. Reset, empty the water and heat. The effect reports failure. Refill and heat
   again to recover.

Keyboard shortcuts while the canvas has focus: **1/2/3** order, **H** heat,
**B** brew, **S** serve the next waiting order, **P** pause/resume, **Space** step,
**R** reset. All use the same Rust dispatch path as GPUI buttons.

The HTML panel only reads `gpui_snapshot()` and `gpui_source()` from this same
GPUI-owned host. It never sends actions, runs another Machine or decides when
tea is ready. The source sections are embedded from the compiled Rust files.
The native demonstration's Tokio Interpreter is a different host profile.

## Current limits

The pinned GPUI web backend exposes the canvas, but not its buttons, to browser
accessibility APIs. Keyboard shortcuts are available; the sibling HTML variant
provides semantic controls for screen readers. Phone rendering and input must
be checked in the target browser. This demo does not promise screen-reader
support for the GPUI canvas or universal GPU compatibility.

The bundled IBM Plex Sans font and GPUI licenses are in `assets/` and copied
into the static output. The shop illustration reuses the original tea-house
artwork; GPUI renders it as an SVG Image and Rust updates its phase/table state.
