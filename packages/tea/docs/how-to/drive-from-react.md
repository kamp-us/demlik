# Drive a machine from React

To use a `@demlik/tea` machine as a component's state, reach for `useMachine`
from `@demlik/tea/react`. It builds and owns a runtime for the lifetime of the
mount and hands you back `[state, send]`. Like `useReducer`'s dispatch,
`send(msg)` returns `undefined` immediately. The hook imports no engine: you
hand it the engine's `run`.

The machine driven here is the download from
[Build and replay your first machine](../tutorial/build-your-first-machine.md):

```ts
import { defineMachine } from "@demlik/tea";

export interface State {
  readonly phase: "idle" | "downloading" | "done";
  readonly received: number;
  readonly total: number;
}

export type Msg =
  | { readonly type: "start"; readonly total: number }
  | { readonly type: "chunk"; readonly size: number };

/** A download that counts the bytes it has received until it has them all. */
export const downloader = defineMachine({
  types: { model: {} as State, msg: {} as Msg },
  init: (loaded) => [loaded ?? { phase: "idle", received: 0, total: 0 }, []],
  update: {
    start: (s, m) => [
      { ...s, phase: "downloading", received: 0, total: m.total },
      [],
    ],
    chunk: (s, m) => {
      if (s.phase !== "downloading") return [s, []];
      const received = s.received + m.size;
      return received >= s.total
        ? [{ ...s, received: s.total, phase: "done" }, []]
        : [{ ...s, received }, []];
    },
  },
});
```

## 1. Call `useMachine` in your component

```tsx
import { run } from "@demlik/tea/promise";
import { useMachine } from "@demlik/tea/react";

function Downloader() {
  const [state, send] = useMachine(downloader, { run, ctx: undefined });

  return (
    <div>
      <p>
        {state.phase}: {state.received}/{state.total}
      </p>
      <button type="button" onClick={() => send({ type: "start", total: 3 })}>
        Start
      </button>
      <button type="button" onClick={() => send({ type: "chunk", size: 1 })}>
        Receive chunk
      </button>
    </div>
  );
}
```

Each `send` queues a Msg to fold through `update` and re-render with the next state.
Read the rendered state for the outcome. Failures go once to the run's `onError`,
under the phase that failed, such as `"reduce"`, `"boot"`, or `"sub"`.
The page hears right after the save and before the first Cmd's handler starts, so
a machine that moves to `loading` and emits a slow read shows `loading` for the
whole read. It does not wait for the Cmd. A save that fails tells the page
nothing.
A page reloaded in the middle of work does the same: with a `store` holding
`reading` and an `init` that starts the read again, the page shows `reading` during
that read. Until the store has loaded and saved, it shows what `init` gives with
nothing saved.
Under the hood `useMachine` calls the `run` you passed with
`(machine, { ctx, interpret, subscribe })`,
subscribes via `useSyncExternalStore` (so it is tearing-free under React 18's
concurrent rendering), and calls `runtime.stop()` on unmount to drain the queue, up to `disposeTimeoutMs`,
and stop every running Sub.

## 2. Hand it the handlers, and a `ctx` when they need one

A machine that emits Cmds needs the handlers that perform them. Pass them as
`interpret`, the same map `run` takes. If those handlers read dependencies — an
HTTP client, a clock — pass them through `ctx`. Keep the `ctx` object identity
stable (define it outside the component or memoize it), because `useMachine`
rebuilds the runtime whenever the machine, `run`, `ctx`, or `store` identity
changes:

```tsx
const ctx = useMemo(
  () => ({ http: (url: string) => fetch(url).then((r) => r.text()) }),
  [],
);
const [state, send] = useMachine(resilientFetch, {
  run,
  ctx,
  interpret: resilientFetchInterpret,
});
```

A machine that declares Subs of its own (anything past the built-in `timer`)
needs their runners too. Pass them as `subscribe`, again the same map `run`
takes — the hook requires it exactly when `run` would:

```tsx
const [state, send] = useMachine(jobWatcher, {
  run,
  ctx,
  subscribe: {
    job_poll: (sub, _ctx, dispatch) => {
      const timer = setInterval(
        () => dispatch({ type: "poll_due", jobId: sub.deps.jobId }),
        2_000,
      );
      return () => clearInterval(timer);
    },
  },
});
```

`interpret` and `subscribe` are the exception to that identity rule. The hook
reads each handler from the latest render when a Cmd runs or a Sub starts, so a
handler table written inline — one that closes over props or state — never
rebuilds the runtime.

## 3. Persist across mounts with a `store`

Pass a `store` in the same options object to make the component's machine durable
— it boots from the stored Model and writes through on every transition, exactly
as in "Make a machine durable and crash-recoverable":

```tsx
const [state, send] = useMachine(downloader, {
  run,
  ctx: undefined,
  store,
});
```

A fenced store must also be given an `onError`, or it does not compile. `useMachine`
reads the latest render's, so passing one inline does not replace the run. See
[refusing a second writer](./make-durable.md#4-refuse-a-second-writer-if-two-processes-can-reach-the-storage).

## 4. Know what happens under Strict Mode and `<Activity>`

React runs an effect's cleanup without the component going away in two cases.
`useMachine` holds up in both, on the engine you handed it.

**Strict Mode** runs each effect, its cleanup, then the effect again on mount.
That does nothing here: one run starts, `run` is called once, and each Sub starts
once. The hook starts the run in an effect, so a render that React repeats or
throws away starts nothing.

**`<Activity>`**, which needs React 19.2 or later, runs the cleanups on hide and
the effects again on show. A hide stops the machine's Subs and nothing else. It
is one run from mount to unmount:

- **On hide**, every Sub's cleanup runs, the built-in `timer` included. A Sub the
  State asks for while hidden waits for the show.
- **On show**, the Subs start again. A `timer` starts its countdown over.
- **`state` keeps its value**, on a machine with a `store` and on one without.
  `init` is not called again, and nothing is saved or loaded by the hide or the
  show: every transition has already saved.
- **A Cmd in flight lands.** A screen hidden while it loads reaches its answer
  whether the answer comes during the hide or after the show, and the handler
  runs once. You write nothing for this.
- **A Msg dispatched while hidden folds at once**, and any Cmd it emits runs. So a
  parent can keep talking to a hidden screen, and that screen does work off
  screen. If it should not, have the parent stop sending.
- **`send` stays the same function**, so a handler a child kept from before
  the hide still works after the show.

A tree first mounted hidden runs no effects, so it has no run until its first
show. A Msg sent before then waits and folds when the run starts. `send` itself
returns immediately, even while the Msg is waiting.

After a real unmount, a Msg still waiting and any later `send` reach `onError`
as a `DispatchDiscardedError` under `phase: "discard"`. That holds on every React from 18 on, a tree
deleted while a Suspense fallback hides it included.

## 5. Render a run the component does not own

`useMachine` builds the run and stops it on unmount, and it hands back no
handle. When you need the handle itself (to call `done()`, attach an `observe`
listener, or read `result()`), build the run yourself with `run(...)`, await
its `ready`, and pass the booted handle to `useRuntime` from the same module.
It accepts the run from either engine, or a hand-built handle with `subscribe`,
`getState`, and a Promise-returning `dispatch`. It returns the same `[state, send]`
pair. The optional `{ onError }` hears Msgs that never reached a stopped run and
failures from a hand-built handle's `dispatch`. The run reports its own step
failures to its own sink. Pass the same sink to both to hear all failures together:

```tsx
import type { OnError } from "@demlik/tea";
import { useRuntime } from "@demlik/tea/react";

const onError: OnError = (error, context) =>
  console.error("run error", context.phase, error);
const runtime = await run(downloader, {
  ctx: undefined,
  terminal: (s) => s.phase === "done",
  onError,
}).ready;

function Progress() {
  const [state, send] = useRuntime(runtime, { onError });

  return (
    <div>
      <p>
        {state.received}/{state.total}
      </p>
      <button type="button" onClick={() => send({ type: "chunk", size: 1 })}>
        Receive chunk
      </button>
    </div>
  );
}

// Elsewhere, the owner of the handle waits for the run and stops it.
function finish<S>(owned: { done(): Promise<S>; stop(): Promise<void> }) {
  return owned
    .done()
    .catch((error: unknown) => {
      console.error("run failed", error);
      return undefined;
    })
    .finally(() => owned.stop());
}

const finished = finish(runtime);
```

`useRuntime` never calls `stop()`. Whoever built the run stops it.

`done()` rejects when a run fails: with `SubFailedError` when a Sub fails, and with
what the reducer threw when `update` throws. A `done()` nobody awaits needs a catch,
because an unhandled rejection ends a Node process. With the catch above, `finished`
never rejects. It holds the terminal State, or `undefined` if the run failed, so you
can leave it unawaited. Replace the `console.error` with whatever your host does
about a failed run.

A failed run stops by itself: after a Sub failure, and after a reducer throw under the
default `stop` strategy, its Subs close and its final save runs with no call from you.
The `finally` is still what stops a run that reached its terminal State, and on a run
that already stopped itself, its `stop()` does nothing more.

`send` has no Promise to catch. A reducer throw or Sub failure reaches the run's
`onError` once. A send to a stopped run reaches the hook's sink as a
`DispatchDiscardedError` under `phase: "discard"`; a hand-built handle's dispatch
failure reaches it under `phase: "follow-up"`. Both hooks read the latest sink
without replacing `send`.

The `done()` catch and `onError` keep a Node process alive through a failed run.
With no `onError`, the default sink rethrows a Sub failure or reducer throw on a
later tick. Discard notices warn by default.

If you previously awaited the hook's `dispatch`, remove that await and render the
outcome from state. If host code must wait for a step, own the handle and use its
engine's `dispatch`, `idle`, or `done`. On the Effect engine, execute those Effects.

A listener hears before the Cmds run, so hearing one does not mean they are done.
When your code needs that, use `observe` or `on`, which hear after a transition's
Cmds, or `done()`.

## 6. Read only part of the model

For a desk of tiles, let each tile read its own part with
`useRuntime(run, (m) => m.views[id])`. When another tile changes, this reader
keeps the same selected object and does not re-render because of that update.
React compares the selected value with `Object.is`; there is no equality option.
To supply an error sink too, use `useRuntime(run, select, { onError })`.

```tsx
import type { ViewHandle } from "@demlik/tea/react";

type TileId = "inbox" | "notes" | "timer";
type TileMsg = { readonly type: "increment" };
type DeskModel = {
  readonly views: Readonly<Record<TileId, { readonly n: number }>>;
};
type DeskMsg = {
  readonly type: "tile";
  readonly id: TileId;
  readonly msg: TileMsg;
};
type DeskRun = ViewHandle<DeskModel, DeskMsg>;

function Tile({ run, id }: { run: DeskRun; id: TileId }) {
  const [view, send] = useRuntime(run, (m) => m.views[id]);
  const sendToTile = (msg: TileMsg) => send({ type: "tile", id, msg });

  return (
    <button type="button" onClick={() => sendToTile({ type: "increment" })}>
      {id}: {view.n}
    </button>
  );
}

function Desk({ run }: { run: DeskRun }) {
  return (
    <div>
      {(["inbox", "notes", "timer"] as const).map((id) => (
        <Tile key={id} run={run} id={id} />
      ))}
    </div>
  );
}
```

Keep unchanged tile objects when updating the model. The selector should **pick**
a part, not **build** a new object or array: a fresh value on every snapshot read
makes React warn that the snapshot should be cached and can cause a render loop.
Pick stable parts, then derive objects or arrays from them during render.

The returned `send` still accepts the whole run's Msg and stays stable when the
selector changes. `sendToTile` binds that sender to the tile's id in the caller,
like Elm's `Html.map`.

## 7. Send across an extension bridge

`useBackgroundRuntime` from `@demlik/tea/extension` returns `{ state, dispatch }`.
Its `dispatch(msg)` also returns `undefined` immediately. Supply `onError` beside
`channel` and `parseState` to hear transport rejections under `phase: "follow-up"`.
The background run's own `onError` hears its step failures. The bridge's low-level
`bridgeClient.dispatch` still returns a Promise for hosts that need to wait.

`createBackgroundRuntimeContext` keeps the same Provider and consumer names:
`useDispatch()` returns the same returnless sender, and `useRuntime()` returns
`{ state, dispatch }`. Set `opts.onError` on the Provider for transport failures.
