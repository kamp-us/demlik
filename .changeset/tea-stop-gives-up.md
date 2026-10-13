---
"@demlik/tea": minor
---

`stop()` no longer waits without limit for a Cmd handler that has not returned. It waits for the queue up to `disposeTimeoutMs` (5 seconds unless you set it), then reports a `DrainTimeoutNotice` to `onError` under `phase: "discard"`, stops the Subs, runs the final save and returns. Before this, one handler that never returned meant `stop()` never returned, and the Sub cleanup and the final save never ran.

**Behaviour change.** A handler `stop()` gave up on is still running after `stop()` has returned. What it returns later is dropped, and so are the next Cmd of its step and the Msgs queued behind it. Each dropped Msg is a `DispatchDiscardedError`. A handler that needs longer than five seconds to finish during a stop needs a larger `disposeTimeoutMs`.

tea starts no store call after `stop()` has returned. A store call already under way when `stop()` gave up is not cancelled and can finish after `stop()` has returned. On a plain store a save that lands late can overwrite what a newer run saved; a fenced store (`{ fenced: true }`) refuses it with `StoreConflictError`. A host that starts a new run on the same store after a `stop()` that gave up needs a fenced store.

`DrainTimeoutNotice` is a new export. It carries `cmdTypes` (the Cmd of each handler still running), `pendingCmds` and `timeoutMs`, and it is warn-only like every `RuntimeDiscardNotice`.

`runToTerminal` with `timeoutMs` now rejects with `TerminalTimeoutError` at its window when a Cmd handler is still running. It used to wait for that handler first, so it rejected late or never. It starts the teardown and does not wait for it.

The same limit applies on the Effect engine, where `stop()` already interrupts every handler, so only a handler that cannot be interrupted reaches it. See ADR 0025.
