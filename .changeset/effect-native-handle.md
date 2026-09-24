---
"@demlik/tea": minor
---

The Effect engine's `run` now yields an Effect handle instead of the Promise
engine's (#308). The members keep the Promise engine's names; where that handle
returns a Promise, this one returns an Effect with a typed error channel, so a
host sorts failures with `Effect.catchTags` instead of wrapping every call in
`Effect.tryPromise`.

- `dispatch` and `dispatchOnce` return `Effect<void, Err | Stopped | StoreFailed>`,
  where `Err` is the declared failure of the run's hand-written `interpret`
  cells. `ready` returns `Effect<EffectRuntime, Err | StoreFailed>`. `idle`,
  `done` and `stop` return Effects that never fail. `getState`, `result` and the
  listeners (`subscribe`, `observe`, `onBoot`, `on`, the Port members) are
  unchanged.
- New `Stopped` (`msgType`, and `when`: `"stopping"` or `"stopped"`): a dispatch
  into a run that is stopping or has stopped.
- New `StoreFailed` (`operation`: `"load"` or `"save"`, `cause`): a save that
  threw, a fenced store's `StoreConflictError` included, or saved state `ready`
  could not restore (the `cause` is then the `StoreRefusedError`). This covers
  #319.
- A hand-written cell's failure now fails the dispatch with that value, typed,
  instead of rejecting with it untyped. A reducer throw, a Msg with no cell and
  a livelock are still bugs, so they end the Effect as a defect.
- New types `EffectBootingRuntime`, `EffectRuntime` and `CellErrors`.
- `run` still needs a `Scope`, and closing it still stops the run and its Subs.
  The `onError` sink is handed the same values as before.

**Breaking:** the Effect handle is no longer a `BootingRuntime` / `RunHandle`.
Replace `yield* Effect.promise(() => handle.ready)` with `yield* handle.ready`,
and `Effect.promise(() => runtime.dispatch(msg))` with
`runtime.dispatch(msg)`. Hosts typed on the Promise handle, like `useRuntime`
from `@demlik/tea/react`, no longer take it.
