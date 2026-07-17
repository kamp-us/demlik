# Drive a machine from React

To use a `@demlik/tea` machine as a component's state, reach for `useMachine`
from `@demlik/tea/react`. It builds and owns a runtime for the lifetime of the
mount and hands you back a `[state, dispatch]` pair shaped exactly like
`useReducer`.

## 1. Call `useMachine` in your component

```tsx
import { useMachine } from "@demlik/tea/react";

function Downloader() {
  const [state, dispatch] = useMachine(downloader, { ctx: undefined });

  return (
    <div>
      <p>
        {state.phase}: {state.received}/{state.total}
      </p>
      <button onClick={() => dispatch({ type: "start", total: 3 })}>
        Start
      </button>
      <button onClick={() => dispatch({ type: "chunk", size: 1 })}>
        Receive chunk
      </button>
    </div>
  );
}
```

Each `dispatch` folds a Msg through `update` and re-renders with the next state.
Under the hood `useMachine` calls `run(machine, { ctx })`, subscribes via
`useSyncExternalStore` (so it is tearing-free under React 18's concurrent
rendering), and calls `runtime.stop()` on unmount to drain the queue and clean up
every active subscription.

## 2. Pass a `ctx` when your effects need one

If your machine's `interpret` reads dependencies — an HTTP client, a clock — pass
them through `ctx`. Keep the `ctx` object identity stable (define it outside the
component or memoize it), because `useMachine` rebuilds the runtime whenever the
machine, `ctx`, or `store` identity changes:

```tsx
const ctx = useMemo(() => ({ http: (url: string) => fetch(url).then((r) => r.text()) }), []);
const [state, dispatch] = useMachine(resilientFetch, { ctx });
```

## 3. Persist across mounts with a `store`

Pass a `store` in the same options object to make the component's machine durable
— it boots from the stored Model and writes through on every transition, exactly
as in "Make a machine durable and crash-recoverable":

```tsx
const [state, dispatch] = useMachine(downloader, { ctx: undefined, store });
```

When you need the runtime handle itself (to call `done()`, attach an `observe`
listener, or read `result()`) rather than just `[state, dispatch]`, use
`useRuntime` from the same module.
