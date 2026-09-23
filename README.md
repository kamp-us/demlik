# @demlik/tea

A TEA / Elm-Architecture TypeScript library for durable, replayable state machines — one pure reducer, every host adapter.

## Install

```sh
pnpm add @demlik/tea
```

The one runtime dependency is `@standard-schema/spec`, a types-only package
installed for you. `Cmd.define` takes any Standard Schema, so bring the schema
library you already use (zod, or Effect Schema through
`Schema.toStandardSchemaV1`). The host and
testing adapters ride on optional peers you add only for the surface you use:
`react` / `react-dom` (the `./react` hooks), `ws` (Node WebSocket subs),
`fast-check` (the `./pbt` property-testing helpers), `vitest` (the testing
utilities), and `effect` (the `./effect` engine).

## Quickstart

A machine is plain data: an `init` and an `update` map keyed by `Msg` type.
`run` drives it, and when it has effects you hand `run` the `interpret` map
that performs them; `dispatch` folds a `Msg`; `getState` reads the current
Model. You name the Model and the `Msg` union
once, under `types`; everything else is inferred from the machine itself.

```ts
import { defineMachine } from "@demlik/tea";
import { run } from "@demlik/tea/promise";

type State = { readonly count: number };
type Msg = { readonly type: "increment" } | { readonly type: "reset" };

const counter = defineMachine({
  types: { model: {} as State, msg: {} as Msg },
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

## Two engines, one machine

The package has three entry points. A machine file imports only the first, so
it runs unchanged on either engine.

- `@demlik/tea` — the core: `defineMachine`, `Cmd`, `replay` and the types. It
  imports no engine.
- `@demlik/tea/promise` — the Promise engine. Handlers return Promises.
- `@demlik/tea/effect` — the Effect engine (`experimental`, Effect v4). Handlers
  return Effects, services come from your Layers, and closing the scope
  interrupts whatever is in flight.

[Run a machine on the Promise engine](https://github.com/kamp-us/demlik/blob/main/docs/how-to/run-on-the-promise-engine.md)
and [on the Effect engine](https://github.com/kamp-us/demlik/blob/main/docs/how-to/run-on-the-effect-engine.md)
build on the same machine file. Coming from 0.15?
[The migration guide](https://github.com/kamp-us/demlik/blob/main/docs/how-to/migrate-from-0-15.md)
shows every removed or reshaped API, before and after.

## Documentation

The four Diátaxis quadrants live in [`docs/`](https://github.com/kamp-us/demlik/blob/main/docs/README.md):

- [Tutorials](https://github.com/kamp-us/demlik/blob/main/docs/tutorial/index.md) — learning-oriented lessons that take you through the library by building a real machine.
- [How-to guides](https://github.com/kamp-us/demlik/blob/main/docs/how-to/index.md) — goal-oriented directions for getting a specific job done.
- [Reference](https://github.com/kamp-us/demlik/blob/main/docs/reference/index.md) — information-oriented API description, generated per public module.
- [Explanation](https://github.com/kamp-us/demlik/blob/main/docs/explanation/index.md) — understanding-oriented discussion of how it works and why it is shaped this way.

Two more surfaces sit behind those, for people working on the library rather than using it:
[`.patterns/`](https://github.com/kamp-us/demlik/blob/main/.patterns/index.md) is how the code is shaped, and
[`.decisions/`](https://github.com/kamp-us/demlik/blob/main/.decisions/index.md) is why it was shaped that way.
