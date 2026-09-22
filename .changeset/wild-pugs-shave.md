---
"@demlik/tea": minor
---

`@demlik/tea/testing` publishes `drive` — the runtime's Cmd→handler→settle-Msg
loop as one call, for a test.

`bindMachine` returns the Cmds a fold emitted and stops; performing them was
the caller's, so every consumer test exercising a Cmd-emitting machine
hand-wrote the same guarded loop (including the one the jev how-to shipped as
a thing to copy).

```ts
import { drive } from "@demlik/tea/testing";

const { state, trace } = await drive(
  machine,
  initial,
  { type: "classify", key, memo, at: 0 },
  ask.handlers(),
);
```

`drive` composes `bindMachine`'s synchronous `step` and adds no second reducer
path — no `Runtime`, no observation, no clock. It returns the **history** as
well as the endpoint: `trace` is every Cmd dispatched and every Msg folded, in
order, so a test asserts on the sequence too, and replaying the trace's Msgs
through `replay` from the same initial state reproduces the returned `state`.

Exceeding `maxRounds` (default 100) throws `DriveRoundsExceededError` carrying
the round count and the partial trace, rather than returning a half-driven
state a test would assert green on. A rejecting handler's own error propagates
unchanged, with the partial trace recoverable via `driveTraceOf`.

Also exported: `DriveResult`, `DriveTraceEntry`, `DriveOptions`,
`DriveCtxArg`, `DriveNoHandlerError`, `DEFAULT_MAX_ROUNDS`.
