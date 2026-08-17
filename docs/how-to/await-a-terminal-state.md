# Await a machine's terminal state from the caller

To run a one-shot decision machine — a credibility probe, an auth mint, a
validation pass — and then throw-or-proceed at the caller boundary, hand
`@demlik/tea/await-terminal` your own terminal predicate and await the `Promise<S>`
it resolves on the first terminal transition.

## 1. Name the terminal states yourself

tea has no built-in terminal-set concept and this helper does not invent one. The
predicate is a plain function over your Model:

```ts
interface JobState {
  readonly phase: "idle" | "working" | "done";
}

const isDone = (s: JobState): boolean => s.phase === "done";
```

## 2. Await a runtime you already booted

`awaitTerminal` attaches to a running `Runtime` and resolves with the state of
the first transition that satisfies the predicate:

```ts
import { awaitTerminal } from "@demlik/tea/await-terminal";
import { run } from "@demlik/tea";

const runtime = await run(job, {}).ready;

const terminal = awaitTerminal(runtime, isDone);
await runtime.dispatch({ type: "start" });
await runtime.dispatch({ type: "finish" });

const state = await terminal; // { phase: "done" }
await runtime.stop();
```

Attach before you dispatch. Two cases are already handled and are exactly the
ones a hand-rolled promise gets wrong: a runtime that is *already* terminal at
attach resolves synchronously off `runtime.getState()` rather than waiting for a
transition that will never come, and the `observe` subscription is detached the
instant it resolves — no leak, no further predicate calls, no polling loop.

## 3. Bound it, and get a checkable rejection

`timeoutMs` is a plain caller-boundary timer. It rejects with
`TerminalTimeoutError` rather than silently resolving, and it is cleared on the
resolve path so a resolved await never later rejects or leaves a dangling timer:

```ts
import { TerminalTimeoutError, awaitTerminal } from "@demlik/tea/await-terminal";

try {
  const state = await awaitTerminal(runtime, isDone, { timeoutMs: 1_000 });
  proceed(state);
} catch (err) {
  if (err instanceof TerminalTimeoutError) {
    // err.timeoutMs — the deadline that elapsed
    giveUp();
  }
  throw err;
}
```

The error carries a `_tag` discriminant too, so a tag-matching caller branches
without `instanceof`.

## 4. Or boot, seed, await, and tear down in one call

When the machine exists only to answer one question, `runToTerminal` owns the
whole lifecycle: it `run`s the machine, attaches the await *before* dispatching
the seed messages, and calls `runtime.stop()` on both the resolve and the reject
path:

```ts
import { runToTerminal } from "@demlik/tea/await-terminal";

const state = await runToTerminal(
  job,
  { msgs: [{ type: "start" }, { type: "finish" }] },
  isDone,
  { timeoutMs: 1_000 },
);
```

The seed carries the machine's `ctx` alongside `msgs`, conditionally optional
exactly as `run`'s own — a pure machine omits it, as above. A reducer or
interpret throw during seeding surfaces as a rejection rather than floating as an
unhandled one, and a timed-out `runToTerminal` never leaves the runtime running.

That is the whole module: it rides the observation surface `@demlik/tea` already
exposes — `getState`, `observe`, `stop` — and adds no new runtime capability. It
is small on purpose, because the ten lines it replaces are the ten every
integration seam was re-deriving, and two of them were the immediate-terminal
case and the detach. It is *not* an in-loop progress deadline: for a machine that
must bound its own work between transitions, use `@demlik/tea/deadline` or
`@demlik/tea/with-deadline` instead.
