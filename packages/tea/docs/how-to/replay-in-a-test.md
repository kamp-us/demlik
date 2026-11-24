# Replay a recorded run in a test

To assert what a machine *did* without spinning up a live runtime, mocking an
effect, or awaiting a timer, replay the messages it folded and check the
resulting Model. `replay` composes `init` + `update` only — it never runs an
`interpret` handler, never touches a `Store`, and never starts a subscription —
so a replay test is pure, synchronous, and deterministic.

## 1. Replay the messages directly

Hand `replay` the machine, the message list, and the `ctx` your `init` expects.
It returns the final `state`, the `cmds` that would have been emitted, and the
`subs` that would be running at the end, each as its runner would see it
(`{ id, _tag, deps }`):

```ts
import { replay } from "@demlik/tea";

const msgs: Msg[] = [
  { _tag: "start", total: 3 },
  { _tag: "chunk", size: 1 },
  { _tag: "chunk", size: 1 },
  { _tag: "chunk", size: 1 },
];

const { state, cmds } = replay(downloader, { msgs, ctx: undefined });

expect(state.phase).toBe("done");
expect(cmds).toEqual([]); // this machine emits no effects
```

Because the fold is pure, the same messages always produce the same `state` — so
this test can never flake on timing.

To test restored initialization, pass `loaded`. Init may transform that State
and emit resume Cmds; `replay` collects those Cmds along with the update Cmds.
To step an existing State without initializing it, use `step` or
`bindMachine(...).step` from `@demlik/tea/testing`.

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
  { msgs: [{ _tag: "fetch", url: "/x", at: 1000 }], ctx },
  { _tag: "do_fetch", url: "/x" },
);
```

## 3. Replay a trace captured from a live run

For a run whose messages you did not write by hand, record them off a live runtime
with `@demlik/tea/parity`'s `recordRun` and re-fold the captured trace with its
`goldenReplay`. It folds from the captured post-init State without calling
init again or executing any commands. `replayTrace` from
`@demlik/tea/persistence` uses the same captured-State fold and reports the
first differing field. A trace recorded with `captureSteps: true` also names
the Msg it starts at (`divergence.at`), and a Msg the machine no longer has a
cell for comes back as `refusal` rather than a throw. Such a trace also keeps
the Cmds each Msg started, so a change that leaves every State alone but starts
different effects diverges too, at a path such as `cmds[0].total`. A trace without a captured starting State is refused;
record the boot rather than trying to reconstruct it with fresh init. A recording read back from storage has plain data for its states and Msgs, not the
machine's types: `replayStoredTrace` takes it as a `Trace<unknown, { readonly _tag: string }>`
and returns `unknown` states. It trusts the recording to be the machine's own, which
`replayTrace` checks at compile time and `replayStoredTrace` cannot. A `runStepLoop` drive records the same way: its `attach` option hands you the drive's runtime for `recorder`, and `stepLoopMachine` from `@demlik/tea/do` is the machine to replay it against. That is how a stuck run becomes a diff at one field instead of a re-run;
[Gate a refactor on a parity check](./gate-a-refactor-on-parity.md) walks the full
record-then-replay loop.

## 4. Keep only the last N transitions of a long run

A flight recorder on a long-running machine, one that saves the trace only when
the run fails, should not hold every msg since boot. Give `recorder` a
`window`:

```ts
import { recorder, replayTrace } from "@demlik/tea/persistence";

const rec = recorder(runtime, { window: 500 });
// ... thousands of transitions later, the run fails ...
const trace = rec.dump(); // the last 500 msgs
replayTrace(machine, trace).matches; // true
```

The recorder holds at most `window` msgs and State refs, whatever the run
length. When a transition falls out of the window, the trace's `loaded` anchor
moves to the State after it, which is the State before the oldest kept msg. So
the windowed trace replays exactly as an unbounded one does: `replayTrace` folds
the kept msgs from that anchor and reproduces `finalState`, and the same holds
after `toJSONL` and `parseJSONL`. With `captureSteps: true`, `steps` holds one
entry per kept msg.

`trace.skipped` counts the transitions before the anchor, so the first kept msg
is the live run's step `skipped + 1`. It is absent, read as 0, on a trace that
kept everything, and the JSONL boot line carries it. A recording without a
`window` writes the same JSONL it always did.

`window` must be an integer of at least 1, and it cannot be combined with a
`sampleRate` below 1: a sampled trace is not replay-faithful, so it has no
anchor to move. `recorder` throws a `RangeError` for either.
