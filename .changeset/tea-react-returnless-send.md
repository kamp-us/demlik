---
"@demlik/tea": minor
---

**Breaking change:** React hooks now hand event handlers a sender that returns
`undefined` immediately. `useMachine` and `useRuntime` previously returned
`[state, dispatch]` with `(msg) => Promise<void>`; they now return `[state, send]`
with `(msg) => void`. `useRuntime` accepts booted runs from either engine, plus
hand-built handles with `subscribe`, `getState`, and Promise-returning `dispatch`.

`useBackgroundRuntime` keeps `{ state, dispatch }`, but its `dispatch` changes
from `(msg) => Promise<void>` to `(msg) => void`. The context's `useDispatch()`
and `useRuntime().dispatch` change the same way; Provider options now accept
`onError` for transport failures under `phase: "follow-up"`.

Remove awaits and `.catch` calls on hook senders and render the outcome from
state. If host code needs completion, own the run and use its engine's
`dispatch`, `idle`, or `done` (execute the Effects on the Effect engine).
Step failures reach the run's `onError` once. A Msg held at unmount or sent
after stop is reported as `DispatchDiscardedError` under `phase: "discard"`.
Pass `{ onError }` to `useRuntime` for these discards and hand-built handle
failures (`phase: "follow-up"`); background step failures keep their host sink.
