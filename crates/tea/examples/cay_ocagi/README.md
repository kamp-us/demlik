# Çay Ocağı

A small, interactive Turkish tea house that runs on the real native Rust `demlik-tea` runtime. The browser draws the room and sends actions. Rust owns the orders, inventory, phase transitions, failures, timers, and message inbox.

## Open the delivered app

From the delivered `demos/cay-ocagi` folder:

```sh
./cay-ocagi
```

Open **http://127.0.0.1:4318**. No Cargo, Node, account, or internet connection is needed. All HTML, CSS, JavaScript, illustrations, and displayed Rust source are embedded in the binary. Stop with Ctrl+C. To use another port: `CAY_PORT=4320 ./cay-ocagi`.

The binary is built for this Mac. All state is in memory; restarting starts a new shift. This is a local teaching simulation, with simulated heating and delivery, not a connection to physical equipment or Discord.

## First cup, together

1. Click **Nasıl çalışıyor? → İlk çayımı yapalım** for a guided first service, or click any guest's table.
2. Send an order, light the semaver with **Ateşi yak**, then **Demle**.
3. Click **Servis et** beside the order. A tray travels to the guest; Rust receives `ServeFinished` and counts the glasses.
4. Click **Ⅱ** to pause. Send a few orders: their messages stay in **Rust inbox**, while the order ledger stays unchanged. **▷│** advances one simulation second and processes at most one inbox message. Timer completion messages use that inbox too.
5. Start **Yeni vardiya**, then **Küçük bir hata deneyi**. The water is emptied. Light the semaver: `HeatFinished` returns an `Err`. Refill with **SU +** and try again.

The default speed is 2×. Heating takes 6 simulation seconds, brewing 8, and delivery 2.5. You can take other orders while a timer task is waiting.

## What the Rust words mean

| Rust | Tea-house meaning |
| --- | --- |
| `Model` | The ledger: everything the shop currently knows. |
| `Msg` | A ticket saying something happened. |
| `update` | The rules: current Model + Msg → new Model + commands. It is pure. |
| `Cmd` | A work order, such as `HeatWater`. Data describing work. |
| `Interpreter` | Starts the work. Here it starts a Tokio local timer task. |
| `channel` | A bounded message inbox inside the Rust process. `tx` sends, `rx` receives. |
| `async / await` | A task can wait while other tasks keep working. |

A Rust channel is a transport between parts of the program. Discord's “channel 42” is a chat room identifier; these are different meanings of “channel”.

The **order ledger** holds guests waiting for tea. The **Rust inbox** holds messages waiting to be processed. They are separate queues.

## Actual execution path

```text
Browser action → POST /api/action → typed Msg → std::sync::mpsc inbox
                                                       ↓
                                              runtime.dispatch_once
                                                       ↓
                                            demlik_tea::Machine
                                                  update
                                               ↙       ↘
                                          new Model     Cmd
                                                        ↓
                                               native Interpreter
                                                        ↓
                                                Tokio timer task
                                                        ↓
                                      completion Msg → same mpsc inbox
```

The interpreter starts each timer task and promptly returns an empty completion list. When the timer finishes, the task sends the actual completion message through the same inbox as browser actions. This keeps the native runtime responsive and makes pause/step apply to completion messages too. A full inbox retains timer results until there is room. The app's Tokio `LocalSet` owns the lifetime of these tasks; process shutdown ends them.

The right panel shows exact excerpts extracted from the source embedded at compile time using `include_str!`, with original line numbers. Selecting an event shows its real payload and, for transitions, the resulting Model. The UI only renders and interpolates animation between native snapshots.

## Source and rebuild

The example lives on local branch **can/cay-ocagi**, based on the native Rust workspace at `f90dc445c6c83afaaef2a42022aebfd4cff98aba`. The delivered `Source/` directory contains readable copies of the example and assets; `SOURCE-COMMIT.txt` identifies the final source commit.

The temporary build worktree and its target directory are removed after delivery. To rebuild, create a fresh checkout from the retained local branch:

```sh
git -C /private/tmp/demlik-rust-driver-01a16c9d worktree add \
  /private/tmp/demlik-cay-ocagi-rebuild can/cay-ocagi
cd /private/tmp/demlik-cay-ocagi-rebuild
unset CARGO_TARGET_DIR DEMLIK_MUTATION_TARGET_DIR CARGO_BUILD_TARGET_DIR CARGO_BUILD_BUILD_DIR
cargo run -p demlik-tea --example cay_ocagi
```

On this machine the prepared offline toolchain can be selected before Cargo:

```sh
source /private/tmp/demlik-rust-lean-env-01a16c9d.sh
export CARGO_HOME=/private/tmp/demlik-pbt-cargo-home-01a16c9d
```

Main files:

- `cay_ocagi.rs`: loopback HTTP adapter, real bounded inbox, native runtime wiring, source extraction.
- `cay_ocagi/domain.rs`: Model, Msg, Cmd, pure update, focused transition tests.
- `cay_ocagi/native.rs`: native Tokio timer interpreter and host view types.
- `cay_ocagi/index.html`, `style.css`, `app.js`: illustrated scene and renderer.
- `cay_ocagi/smoke.py`: real API journey on a separate test instance.

## Verification

Focused Rust checks:

```sh
cargo test -p demlik-tea --example cay_ocagi
```

Start a spare instance, then exercise it:

```sh
CAY_PORT=4319 cargo run -p demlik-tea --example cay_ocagi
# In another terminal:
python3 crates/tea/examples/cay_ocagi/smoke.py http://127.0.0.1:4319
```

The native API journey checks a paused three-message inbox, one-message stepping, an order and cancellation during heating, three tables receiving six glasses with conserved stock, and empty-water failure followed by refill and retry. The browser was also exercised through the actual controls at desktop and 390px mobile widths.
