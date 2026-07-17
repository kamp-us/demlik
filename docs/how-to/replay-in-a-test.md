# Replay a recorded run in a test

To assert what a machine *did* without spinning up a live runtime, mocking an
effect, or awaiting a timer, replay the messages it folded and check the
resulting Model. `replay` composes `init` + `update` only — it never runs an
`interpret` handler, never touches a `Store`, and never starts a subscription —
so a replay test is pure, synchronous, and deterministic.

## 1. Replay the messages directly

Hand `replay` the machine, the message list, and the `ctx` your `init` expects.
It returns the final `state`, the `cmds` that would have been emitted, and the
`subs` that would be desired at the end:

```ts
import { replay } from "@demlik/tea";

const { state, cmds } = replay(downloader, {
  msgs: [
    { type: "start", total: 3 },
    { type: "chunk", size: 1 },
    { type: "chunk", size: 1 },
    { type: "chunk", size: 1 },
  ],
  ctx: undefined,
});

expect(state.phase).toBe("done");
```

Because the fold is pure, the same messages always produce the same `state` — so
this test can never flake on timing.

## 2. Or use the `@demlik/tea/testing` assertions

`@demlik/tea/testing` wraps the common replay checks so a test reads as one line.
`expectFinalState` replays and asserts the whole Model; `expectCmdEmitted`
asserts a particular effect was produced:

```ts
import { expectCmdEmitted, expectFinalState } from "@demlik/tea/testing";

expectFinalState(
  downloader,
  { msgs, ctx: undefined },
  { phase: "done", received: 3, total: 3 },
);

expectCmdEmitted(
  resilientFetch,
  { msgs: [{ type: "fetch", url: "/x", at: 1000 }], ctx },
  { type: "do_fetch", url: "/x" },
);
```

## 3. Replay a trace captured from a live run

For a run whose messages you did not write by hand, record them off a live
runtime with `@demlik/tea/recorder` and re-fold the captured trace with
`@demlik/tea/trace-replay`'s `replayTrace`. It reconstructs the exact final
Model with no model, tool, or clock calls — the same discipline `replay` uses,
applied to a real production trace. That is how a stuck run becomes a diff at one
field instead of a re-run; the `agent-resilient-and-durable` example walks the
full record-then-replay loop.
