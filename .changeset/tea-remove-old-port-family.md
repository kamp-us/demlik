---
"@demlik/tea": minor
---

**Breaking:** the old port family is removed from `@demlik/tea`. The typed ports of ADR 0026 (`port.in` / `port.out` on `defineMachine`, and `tell`) replace it in this same release, so "port" means one thing in every published version.

Removed from `.`:

- `definePort`
- `fromPort`. It gets no replacement.
- `Port`
- `PortEmitter`
- `ctx.emit`. A Cmd handler's ctx is now the `Ctx` handed to `run` and nothing more, plus `ok` / `err` on a `Cmd.define`d Cmd. This changes the ctx type of every handler: `HandlerCtx<Ctx>` no longer includes `PortEmitter`, and a handler that calls `ctx.emit` does not compile.
- `subscribePort` and `emitPort`, on the Promise engine's `BootingRuntime` / `Runtime` and on the handle `noopRuntime` builds in `@demlik/tea/testing`.
- The error phase `"port-emit"`, from `RuntimeErrorPhase`.
- `PortNameCollisionError` and `__resetPortRegistry`, which only `definePort` used.

Removed from `@demlik/tea/effect`: `subscribePort` and `emitPort`, on `EffectBootingRuntime` / `EffectRuntime`.

Removed from `@demlik/tea/flow`: `FanOutPorts`, and the `completion(ports)` member of what `createFanOut` returns. Read a finished batch off `isComplete`, or give the knob a `join` Cmd.

`drive` from `@demlik/tea/testing/promise` no longer adds a no-op `emit` to the ctx it hands a handler.

No export path closes.

To move off the family before the typed ports fit your case: send an outgoing value with a Cmd and its handler, and listen for one named signal with the `events` projector and `runtime.on(type, handler)`.
