---
"@demlik/tea": minor
---

`drive` now has one entry point per engine, and the Effect engine gets one
(#321).

- `@demlik/tea/testing/promise` (stable) is the Promise `drive`, moved off
  `@demlik/tea/testing` with its types and errors (`DriveResult`,
  `DriveTraceEntry`, `DriveOptions`, `DriveCtxArg`, `DriveRoundsExceededError`,
  `DriveNoHandlerError`, `driveTraceOf`, `DEFAULT_MAX_ROUNDS`). Same signature,
  same rounds.
- `@demlik/tea/testing/effect` (experimental) is a new `drive` for the Effect
  engine: `drive(machine, initial, msg, interpret, opts?)` takes the same
  `interpret` map as the Effect engine's `run`, runs the Subs the machine wants
  (through `opts.subscribe` or the built-in runner), and returns
  `Effect<{ state, trace }, DriveRoundsExceededError | DriveNoHandlerError |
  <a hand-written cell's failure>, R>`. Provide `R` with `Effect.provide(layer)`.
  A hand-written cell may return a Msg, a list of Msgs or nothing (#324). It
  runs the same loop as the Promise `drive`, so the rounds and the trace match.
  Next to `@demlik/tea/effect`, it is the only entry point that imports `effect`.
- `@demlik/tea/testing` keeps only the helpers that work with either engine:
  `expectFinalState`, `expectCmdEmitted`, `expectCmdSequence`,
  `expectActiveSubs`, `step`, `expectReplayDeterministic`, `bindMachine`,
  `noopRuntime` and `stateFactory`.
- The Promise `drive` now refuses a `Cmd.define`d handler that dispatches its
  own `_ok` / `_err`, as `run` does (#304). It throws `OutcomeContractError`
  with the trace attached (`driveTraceOf`). A settle minted through
  `cmdEdgeOf(ctx)`, a defined handler's other Msgs, and anything a hand-written
  Cmd's handler dispatches still pass.

**Breaking:** `drive` and its types are no longer exported from
`@demlik/tea/testing`. Change the import to `@demlik/tea/testing/promise`:

```ts
// before
import { drive } from "@demlik/tea/testing";
// after
import { drive } from "@demlik/tea/testing/promise";
```

A test whose defined handler dispatched its own `_ok` / `_err` now fails under
`drive`, as that program already failed under `run`.
