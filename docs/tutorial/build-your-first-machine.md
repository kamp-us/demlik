# Build and replay your first machine

In this lesson you build a working `@demlik/tea` machine from nothing, run it
until it finishes, and then *replay* the exact same run to see the payoff that
makes tea worth using: given the same messages, a machine always lands in the
same state. By the end you will have written a Model, a Msg, an `update`, and
watched determinism fall out for free.

You need only the root package:

```ts
import { defineMachine, replay, run } from "@demlik/tea";
```

## Describe the world with a Model

A machine's Model is a plain, serializable snapshot of everything it knows. You
are building a tiny file download, so the Model is a phase, how many bytes have
arrived, and how many are expected:

```ts
type Phase = "idle" | "downloading" | "done";

interface State {
  readonly phase: Phase;
  readonly received: number;
  readonly total: number;
}
```

Notice there is no `isLoading` boolean and no half-filled optional. The `phase`
field names exactly where the download is, so an impossible in-between can't be
represented.

## Name the things that happen with Msgs

Nothing mutates the Model directly. Instead, events arrive as messages, and each
message is a value with a `type`:

```ts
type Msg =
  | { readonly type: "start"; readonly total: number }
  | { readonly type: "chunk"; readonly size: number };
```

`start` kicks off a download of a known size; each `chunk` reports bytes that
just arrived.

## Fold messages into new state with `update`

`update` is the heart of the machine: a pure function from `(state, msg)` to the
next state plus any effects to run. Here you emit no effects, so every cell
returns an empty effect list `[]`:

```ts
const downloader = defineMachine<State, Msg, never, never, undefined>({
  init: (loaded) =>
    loaded !== null
      ? [loaded, []]
      : [{ phase: "idle", received: 0, total: 0 }, []],
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

`init` returns the starting state (and rehydrates a loaded snapshot when one is
handed in — you can ignore that for now). Each `update` cell returns
`[nextState, effects]`. When enough bytes have arrived, the `chunk` cell flips
`phase` to `"done"` — that is your terminal state.

## Run it and watch it finish

`run` builds a live runtime. Tell it which states count as finished with a
`terminal` predicate, then dispatch messages and await the result:

```ts
const isDone = (s: State) => s.phase === "done";

const runtime = await run(downloader, { ctx: undefined, terminal: isDone })
  .ready;

await runtime.dispatch({ type: "start", total: 3 });
await runtime.dispatch({ type: "chunk", size: 1 });
await runtime.dispatch({ type: "chunk", size: 1 });
await runtime.dispatch({ type: "chunk", size: 1 });

const final = await runtime.done(); // resolves when `isDone` first holds
console.log(final.phase); // "done"
console.log(final.received, "of", final.total); // 3 of 3
await runtime.stop();
```

`await runtime.dispatch(msg)` resolves once the message and all of its
consequences have settled, so by the time `done()` resolves the download has
genuinely reached `"done"`. You just ran your first machine.

## Replay the run — the payoff

Here is why the pure `update` was worth the discipline. Collect the same
messages you dispatched, and hand them to `replay`:

```ts
const msgs: Msg[] = [
  { type: "start", total: 3 },
  { type: "chunk", size: 1 },
  { type: "chunk", size: 1 },
  { type: "chunk", size: 1 },
];

const { state } = replay(downloader, { msgs, ctx: undefined });
console.log(state.phase); // "done" — the exact same terminal Model
```

`replay` folds `init` + `update` and nothing else — it never runs an effect,
never touches storage, never starts a timer. Because your machine's transitions
are pure, the replayed Model is identical to the one the live run produced. The
same messages always yield the same state.

That is the property every other part of tea is built on: a run is data you can
re-fold. Once you trust it, testing becomes "replay the messages and check the
state," and debugging a production run becomes "replay its recorded trace
locally." Both start right here, with a Model, a Msg, and a pure `update`.
