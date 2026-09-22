# Ask Jev a typed question

You have items to classify — expenses, tickets, messages — and a rubric for
them. `@demlik/tea/jev` sends that rubric to [TypeSafe Jev](https://typesafe.ai)
as a map of questions, and the answer comes back **narrowed to the keys you
wrote**: a `choice` question's `criteria` keys are its answer's `choice` domain,
so nothing downstream ever handles a `string` you have to re-validate.

This guide wires one such call into a machine end to end and drives it in a test
with no network, no key and no clock. The door's own surface is in
[the reference page](../reference/jev.md); everything below is the wiring.

## 1. Write the rubric once

`jevQuestions` is an identity function with a `const` type parameter. It exists
so your literal keys survive inference without every call site spelling
`as const`.

```ts
import { jevQuestions } from "@demlik/tea/jev";

/**
 * The rubric, written once. `jevQuestions` is an identity function with a
 * `const` type parameter, so the criteria keys survive inference — which is
 * what makes `Category` below a real union rather than `string`.
 */
export const questions = jevQuestions({
  category: {
    type: "choice",
    instructions: "Which budget line does this expense belong to?",
    criteria: {
      groceries: "Supermarkets, grocers, food shops",
      dining: "Restaurants, cafés, bars",
      transport: "Fares, fuel, ride-hailing, parking",
    },
  },
});

export type Questions = typeof questions;
export type Category = keyof Questions["category"]["criteria"];
```

`Category` is now `"groceries" | "dining" | "transport"` — derived from the
rubric, so adding an option to `criteria` widens it and a `switch` that stopped
being exhaustive says so at compile time.

## 2. Build the knob and splice it into the reducer

`createJevAsk` returns a knob over
[`@demlik/tea/resilience`](../reference/resilience.md)'s resilient-call: `init`,
`attempt`, `succeed`, `fail`, `onTimer` and `subs` are that machine's verbs, and
`handlers()` is the one interpret cell that touches the network. Your reducer
runs the inherited verb first so the backoff loop advances, then folds the
answer into your own state.

`types` names the four types once — `JevCmd<Questions>` and `JevSub` are the
door's own names for the Cmd it emits and the Sub it asks for — and every
`update` cell is inferred from that block, so `s` and `m` arrive narrowed
without an annotation on a single one of them.

The confidence branch is the part that is yours. `JevOk` hands back the
confidence and decides nothing with it, on purpose: what counts as confident
enough to book is a policy per caller.

```ts
import { defineMachine } from "@demlik/tea";
import {
  createJevAsk,
  type JevCmd,
  type JevFailMsg,
  type JevOk,
  type JevRequest,
  type JevSub,
  type JevSucceedMsg,
  type JevTimerMsg,
  liftJevAsk,
  type ResilientState,
  subscribeDeadline,
} from "@demlik/tea/jev";

/** Where one expense ended up. `triage` is a human's queue, not a category. */
export type Verdict =
  | { readonly kind: "booked"; readonly category: Category }
  | { readonly kind: "triage"; readonly why: string };

export interface ExpenseState {
  /** The knob's own slice — resilient-call's, so a rehydrate is free. */
  readonly resilience: ResilientState<JevRequest<Questions>, JevOk<Questions>>;
  readonly verdicts: Readonly<Record<string, Verdict>>;
}

export type ExpenseMsg =
  | {
      readonly type: "classify";
      readonly key: string;
      readonly memo: string;
      readonly at: number;
    }
  | JevSucceedMsg<Questions>
  | JevFailMsg
  | JevTimerMsg;

type Ask = ReturnType<typeof createJevAsk<Questions>>;

/** Below this, a human looks at it. The threshold is the HOST's rule to set. */
export const CONFIDENCE_FLOOR = 0.8;

export function expenseMachine(ask: Ask) {
  return defineMachine({
    types: {
      model: {} as ExpenseState,
      msg: {} as ExpenseMsg,
      cmd: {} as JevCmd<Questions>,
      sub: {} as JevSub,
      ctx: undefined,
    },
    init: (loaded) =>
      loaded !== null
        ? [loaded, []]
        : [{ resilience: ask.init(), verdicts: {} }, []],
    update: {
      classify: (s, m) =>
        liftJevAsk(s, ask.attempt(s.resilience, m.key, m.memo, m.at)),

      // Run the inherited verb FIRST so the backoff loop advances, THEN fold
      // the answer in. `answer.choice` is `Category` here, not `string`.
      resilient_ok: (s, m) => {
        const [slice, cmds] = ask.succeed(s.resilience, m.key, m);
        const answer = m.result.answers.category;
        const verdict: Verdict =
          answer.confidence >= CONFIDENCE_FLOOR
            ? { kind: "booked", category: answer.choice }
            : { kind: "triage", why: `confidence ${answer.confidence}` };
        return [
          {
            ...s,
            resilience: slice,
            verdicts: { ...s.verdicts, [m.key]: verdict },
          },
          cmds,
        ];
      },

      resilient_err: (s, m) => {
        const [slice, cmds] = ask.fail(s.resilience, m.key, m);
        return [
          {
            ...s,
            resilience: slice,
            verdicts: {
              ...s.verdicts,
              [m.key]: { kind: "triage", why: m.error._tag },
            },
          },
          cmds,
        ];
      },

      deadline_exceeded: (s, m) => liftJevAsk(s, ask.onTimer(s.resilience, m)),
    },
    subscriptions: (s) => ask.subs(s.resilience),
    subscribe: { deadline: subscribeDeadline },
    interpret: ask.handlers(),
  });
}
```

Three things to keep as they are:

- **`resilient_ok` calls `ask.succeed` before it reads `m.result`.** Folding
  first and settling second leaves the slice wedged at `running`.
- **`interpret: ask.handlers()`** returns the settle Msg rather than dispatching
  one, so it re-enters through your `resilient_ok` / `resilient_err` arms.
- **`subscribe: { deadline: subscribeDeadline }`** is what makes a backed-off
  retry actually fire. Omit it and a transient failure waits forever.

## 3. Give it a port — or don't

`port` is the injected HTTP caller. The door holds no API key and reads no
environment variable: whoever writes the adapter owns the `Authorization`
header, and that is exactly what lets a test satisfy the same type with a
function.

```ts
import type { JevPort } from "@demlik/tea/jev";

/**
 * Jev, scripted. The same `JevPort` type the `fetch` adapter satisfies, so the
 * machine under test is the machine that ships — and no key, clock or socket
 * is anywhere on the path, which is what keeps the run replayable.
 */
export function fakeJev(
  script: readonly (readonly [Category, number])[],
): JevPort<Questions> {
  const queue = [...script];
  return async () => {
    const next = queue.shift();
    if (next === undefined) return { status: 529, body: {} };
    const [choice, confidence] = next;
    return {
      status: 200,
      body: {
        model: "jev-1",
        answers: {
          category: {
            type: "choice",
            choice,
            confidence,
            probabilities: { [choice]: confidence },
          },
        },
        usage: { input_tokens: 9, output_tokens: 2 },
      },
    };
  };
}
```

Configure `fallback` instead of `port` — or as well as — and the knob answers
from a pure decider on the two paths where the network cannot: no port at all,
or the retry budget spent. It must be pure, because the exhaustion path runs it
inside a reducer verb.

## 4. Drive it in a test

`bindMachine` from [`@demlik/tea/testing`](../reference/testing.md) gives you the
machine's `step` synchronously. Feed the Msg, run the real interpret handler
over each Cmd, feed the settle Msg back — the runtime's own loop, said in a
shape a test can assert between folds.

```ts
import { bindMachine } from "@demlik/tea/testing";

/**
 * Feed one `classify`, run the real interpret handler over every Cmd it
 * emitted, and feed the settle Msg back — which is what the runtime does, said
 * synchronously so a test can assert on the state between two folds.
 */
export async function classifyOne(
  ask: Ask,
  key: string,
  memo: string,
): Promise<ExpenseState> {
  const bound = bindMachine(expenseMachine(ask), undefined);
  let [state, cmds] = bound.step(
    { resilience: ask.init(), verdicts: {} },
    { type: "classify", key, memo, at: 0 },
  );
  for (let guard = 0; guard < 10 && cmds.length > 0; guard += 1) {
    const pending = cmds;
    cmds = [];
    for (const cmd of pending) {
      const settle = await ask.handlers().resilient_run(cmd);
      const next = bound.step(state, settle);
      state = next[0];
      cmds = [...cmds, ...next[1]];
    }
  }
  return state;
}
```

Then the assertions are plain data:

```ts
const ask = createJevAsk({ questions, port: fakeJev([["dining", 0.93]]) });
const state = await classifyOne(ask, "tx-1", "PIZZA NAPOLI 24.10 EUR");
expect(state.verdicts["tx-1"]).toEqual({ kind: "booked", category: "dining" });
```

Swap `0.93` for `0.41` and the same machine returns
`{ kind: "triage", why: "confidence 0.41" }` — the threshold branch, exercised
without a single mock of the door itself.

## Classifying many items at once

One `ask` per item is the wrong shape past a handful. `createClassifyBatch`,
from the same door, wires
[`@demlik/tea/flow`](../reference/flow.md)'s batch window and fan-out plus a TTL
cache around `ask`: you call `add(item, at)` and it coalesces, bounds
concurrency, and never re-asks about a key it has cached. It writes no chunker,
limiter, cache or retry of its own — its knob is in
[the reference page](../reference/jev.md).

## Related

- [Add retry and backoff to a call](./add-resilience.md) — the policy object
  `retry` takes, and what to declare against a provider's 429/529.
- [Replay a recorded run in a test](./replay-in-a-test.md) — the general form of
  step 4, for a machine that is not a Jev call.
