# @demlik/tea

A TEA / Elm-Architecture TypeScript library for durable, replayable state machines — one pure reducer, every host adapter.

## Install

```sh
pnpm add @demlik/tea
```

`better-result` is a runtime dependency and is installed for you. The host and
testing adapters ride on optional peers you add only for the surface you use:
`react` / `react-dom` (the `./react` hooks), `ws` (Node WebSocket subs),
`fast-check` (the `./pbt` property-testing helpers), and `vitest` (the testing
utilities).

## Quickstart

A machine is plain data: an `init`, an `update` map keyed by `Msg` type, and —
when it has effects — an `interpret` map. `run` drives it; `dispatch` folds a
`Msg`; `getState` reads the current Model.

```ts
import { defineMachine, run } from "@demlik/tea";

type State = { readonly count: number };
type Msg = { readonly type: "increment" } | { readonly type: "reset" };

const counter = defineMachine<State, Msg, never, never, unknown>({
  init: (loaded) => (loaded !== null ? [loaded, []] : [{ count: 0 }, []]),
  update: {
    increment: (s) => [{ count: s.count + 1 }, []],
    reset: () => [{ count: 0 }, []],
  },
});

const runtime = await run(counter, { ctx: {} }).ready;
await runtime.dispatch({ type: "increment" });
runtime.getState(); // { count: 1 }
```

## Documentation

The four Diátaxis quadrants live in [`docs/`](./docs/README.md):

- [Tutorials](./docs/tutorial/index.md) — learning-oriented lessons that take you through the library by building a real machine.
- [How-to guides](./docs/how-to/index.md) — goal-oriented directions for getting a specific job done.
- [Reference](./docs/reference/index.md) — information-oriented API description, generated per public module.
- [Explanation](./docs/explanation/index.md) — understanding-oriented discussion of how it works and why it is shaped this way.
