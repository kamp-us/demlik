---
"@demlik/tea": minor
---

One run-handle type that every engine's `run` returns (#281, map finding #250).
`@demlik/tea/react` and `@demlik/tea/do` are typed against it and import no
engine.

**Breaking (`./react`, `./do`, stable tier):** `useMachine` and
`createAgentHost` take the engine's `run` as an input.

```ts
// before
useMachine(machine, { ctx, interpret });
createAgentHost({ buildMachine, store, ctx, toSseFrame });

// after
import { run } from "@demlik/tea/promise";
useMachine(machine, { run, ctx, interpret });
createAgentHost({ run, buildMachine, store, ctx, toSseFrame });
```

- New in `@demlik/tea`: `RunHandle<S, M, E>` (`dispatch`, `subscribe`,
  `observe`, `onBoot`, `on`, `ready`, `stop`), `BootedRunHandle<S, M, E>` (the
  handle `ready` resolves to, adding `getState`), `RunOptions` (the options
  every engine's `run` accepts: `ctx`, `interpret`, `subscribe`, `store`,
  `events`) and `EngineRun` (an engine's `run`, as a host adapter sees it).
  The Promise engine's `BootingRuntime` extends `RunHandle`, and its `Runtime`
  is a `BootedRunHandle`, so `run` from `@demlik/tea/promise` fits `EngineRun`
  as it is.
- `useMachine` rebuilds the runtime when `run`'s identity changes, like
  `ctx` and `store`. Pass the engine's own function, not an inline wrapper.
- `useRuntime` takes any `BootedRunHandle`. `bootResume` and `autoBoot` take
  any `RunHandle`. `driveProjections` and `sseFromAgentEvents` were already
  typed on the members they read, and accept any handle.
- `AgentHost.runtime()` resolves to a `BootedRunHandle`, not the Promise
  engine's `Runtime`, so it has no `result()` / `done()` / `idle()`. Read the
  terminal State from `host.result()`, which now applies the host's `terminal`
  predicate itself.
