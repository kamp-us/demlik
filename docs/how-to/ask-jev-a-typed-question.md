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
`handlers()` is the one interpret cell that touches the network. Mounting it by
hand is eight wiring points, three of which fail only at runtime — so mount it
with `mountResilientCall` instead and spread the fragments it returns.

You still write two things: the cell that STARTS a call (only your Msg knows
which field carries the key, the content and the instant) and what to do with a
settled answer. The fold is handed the model the inherited verb already settled,
so the backoff loop always advances first.

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
  mountResilientCall,
  type ResilientState,
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

/** The Msg that starts one call. `mount` needs its type to write that cell. */
export interface Classify {
  readonly type: "classify";
  readonly key: string;
  readonly memo: string;
  readonly at: number;
}

export type ExpenseMsg =
  | Classify
  | JevSucceedMsg<Questions>
  | JevFailMsg
  | JevTimerMsg;

type Ask = ReturnType<typeof createJevAsk<Questions>>;

/** Below this, a human looks at it. The threshold is the HOST's rule to set. */
export const CONFIDENCE_FLOOR = 0.8;

/**
 * The knob, mounted. `onOk` / `onErr` are handed the model the inherited verb
 * ALREADY settled, so there is no cell to put in the wrong order, and `subs` /
 * `subscribe` / `interpret` ride along on the fragments rather than being
 * remembered — `subs` into the machine, `subscribe` and `interpret` to `run`
 * beside it.
 * `answer.choice` is `Category` here, not `string`.
 */
export function mountAsk(ask: Ask) {
  return mountResilientCall(ask, {
    slice: "resilience",
    attempt: {
      on: "classify",
      run: (slice, m: Classify) => ask.attempt(slice, m.key, m.memo, m.at),
    },
    onOk: (s: ExpenseState, m) => {
      const answer = m.result.answers.category;
      const verdict: Verdict =
        answer.confidence >= CONFIDENCE_FLOOR
          ? { kind: "booked", category: answer.choice }
          : { kind: "triage", why: `confidence ${answer.confidence}` };
      return [{ ...s, verdicts: { ...s.verdicts, [m.key]: verdict } }, []];
    },
    onErr: (s: ExpenseState, m) => {
      const verdict: Verdict = { kind: "triage", why: m.error._tag };
      return [{ ...s, verdicts: { ...s.verdicts, [m.key]: verdict } }, []];
    },
    // A call that dies on its deadline settles inside the slice and emits no
    // settle Msg, so it never reaches `onErr`. Omit this and an expense whose
    // budget runs out gets no verdict written at all.
    onDeadline: (s: ExpenseState, m) => {
      const verdict: Verdict = { kind: "triage", why: "deadline_exceeded" };
      return [{ ...s, verdicts: { ...s.verdicts, [m.key]: verdict } }, []];
    },
  });
}

/** The machine, plus the handlers a host hands to `run` beside it. */
export function expenseMachine(ask: Ask) {
  const mounted = mountAsk(ask);
  const machine = defineMachine({
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
        : [{ ...mounted.init(), verdicts: {} }, []],
    update: { ...mounted.update },
    subs: mounted.subs,
  });
  return {
    machine,
    interpret: mounted.interpret,
    subscribe: mounted.subscribe,
  };
}
```

The three rules this page used to ask you to remember are now shapes you cannot
get wrong: `onOk` never sees the pre-settle slice, `interpret` is the door's
returning handler rather than one you re-declare — handed to `run` beside the
machine — and `subs` / `subscribe` ride on the fragments, so a backed-off retry
is armed by construction.

Three folds, not two. A call that runs out of its deadline settles `failed`
inside the slice with no settle Msg to carry it, so `onErr` never sees that
failure class — `onDeadline` is where it lands. Omit it and the slice still
advances; nothing downstream of it runs.

What the mount does *not* take away is the state
([ADR 0015](../../.decisions/0015-hide-the-wiring-never-the-state.md)):
`resilience` stays a plain field you read, `replay` sees and the journal prints,
and `ask.succeed` / `ask.fail` / `ask.onTimer` / `liftJevAsk` stay exported — a
settle cell the fold cannot express is yours to write by hand and spread beside
the rest.

`types` is still yours to write, and `JevCmd<Questions>` / `JevSub` are the
door's own names for the Cmd it emits and the Sub it asks for; every `update`
cell is inferred from that block.

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
    // `probabilities` is TOTAL over the criteria keys on the wire, so a fake
    // that names only the winner is a body `parseAnswers` refuses. Spread the
    // remaining mass over the other two and let the winner overwrite its own.
    const rest = (1 - confidence) / 2;
    return {
      status: 200,
      body: {
        model: "jev-1",
        answers: {
          category: {
            type: "choice",
            choice,
            confidence,
            probabilities: {
              groceries: rest,
              dining: rest,
              transport: rest,
              [choice]: confidence,
            },
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

`drive` from [`@demlik/tea/testing`](../reference/testing.md) runs the machine
the way the runtime does — fold the Msg, hand every emitted Cmd to the real
interpret handler, feed each settle Msg back, stop when the machine is quiet —
with no runtime, no clock and no socket anywhere on the path. It returns the
settled `state` **and** the `trace`: every Cmd dispatched and every Msg folded,
in order.

```ts
import { type DriveResult, drive } from "@demlik/tea/testing";

/** What one driven classification hands back: the settled state and the history. */
export type Classified = DriveResult<
  ExpenseState,
  ExpenseMsg,
  JevCmd<Questions>
>;

/**
 * Feed one `classify` and let `drive` do what the runtime does: run the real
 * interpret handlers over every Cmd, feed each settle Msg back, and stop when
 * the machine is quiet. It returns the settled state AND the `trace` — every
 * Cmd dispatched and every Msg folded, in order.
 */
export function classifyOne(
  ask: Ask,
  key: string,
  memo: string,
): Promise<Classified> {
  const { machine, interpret } = expenseMachine(ask);
  return drive(
    machine,
    { resilience: ask.init(), verdicts: {} },
    { type: "classify", key, memo, at: 0 },
    interpret,
  );
}
```

`interpret` is the same table a host hands `run`, so the test drives the
**real** interpreter and mocks only the port beneath it. A
machine that never settles is a throw (`DriveRoundsExceededError`, carrying the
partial trace), never a half-driven state handed back as if it were done.

Then the assertions are plain data — and the `trace` answers questions the
settled state cannot:

```ts
const ask = createJevAsk({ questions, port: fakeJev([["dining", 0.93]]) });
const { state, trace } = await classifyOne(ask, "tx-1", "PIZZA NAPOLI 24.10 EUR");
expect(state.verdicts["tx-1"]).toEqual({ kind: "booked", category: "dining" });
// The door was asked EXACTLY once, so this is a first-attempt answer and not
// the end of a retry ladder.
expect(trace.filter((entry) => entry.kind === "cmd")).toHaveLength(1);
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
