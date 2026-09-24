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

## 2. Build the knob and wire it into your reducer

`createJevAsk` returns a knob over
[`@demlik/tea/resilience`](../reference/resilience.md)'s resilient-call. It is
plain functions: `init`, `attempt`, `succeed`, `fail`, `onTimer` and `timer` are
that knob's verbs, and `run` is its one Cmd. You call them from your own
`update`. Nothing mounts or wraps your machine.

`run` is built with `Cmd.define`. List it in `cmds`, and the engine turns your
handler's result into one of two Msgs: `resilient_run_ok` or
`resilient_run_err`. Each carries the Cmd it answers, so `m.cmd.key` says which
call settled.

Read the verdict off the slice after the knob's verb ran, never off the Msg.
That way a call that is still backing off has no verdict yet, and an answer the
fallback gave on a spent budget books like any other. A call that runs out of
its deadline settles `failed` inside the slice with no settle Msg at all, so
the `deadline_exceeded` cell reads the slice too.

The confidence branch is the part that is yours. `JevOk` hands back the
confidence and decides nothing with it, on purpose: what counts as confident
enough to book is a policy per caller.

```ts
import { defineMachine } from "@demlik/tea";
import {
  createJevAsk,
  type JevCmd,
  type JevOk,
  type JevRequest,
  type JevTimerMsg,
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

/** The Msg that starts one call. */
export interface Classify {
  readonly type: "classify";
  readonly key: string;
  readonly memo: string;
  readonly at: number;
}

export type ExpenseMsg = Classify | JevTimerMsg;

type Ask = ReturnType<typeof createJevAsk<Questions>>;
type Call = ExpenseState["resilience"]["calls"][string];

/** Below this, a human looks at it. The threshold is the HOST's rule to set. */
export const CONFIDENCE_FLOOR = 0.8;

/**
 * The verdict a settled call earns, read off the slice AFTER the knob's verb
 * ran — so a retry that is still backing off has no verdict yet, and an answer
 * the fallback gave on a spent budget books like any other.
 * `answer.choice` is `Category` here, not `string`.
 */
function verdictOf(call: Call | undefined): Verdict | undefined {
  switch (call?.phase) {
    case "succeeded": {
      const answer = call.result.answers.category;
      return answer.confidence >= CONFIDENCE_FLOOR
        ? { kind: "booked", category: answer.choice }
        : { kind: "triage", why: `confidence ${answer.confidence}` };
    }
    case "failed":
      return { kind: "triage", why: (call.error as { _tag: string })._tag };
    default:
      return undefined;
  }
}

/** Put the knob's settled slice back, with the verdict for `key` if it has one. */
function settle(
  s: ExpenseState,
  key: string,
  [resilience, cmds]: readonly [
    ExpenseState["resilience"],
    readonly JevCmd<Questions>[],
  ],
): readonly [ExpenseState, readonly JevCmd<Questions>[]] {
  const verdict = verdictOf(resilience.calls[key]);
  const verdicts =
    verdict === undefined ? s.verdicts : { ...s.verdicts, [key]: verdict };
  return [{ resilience, verdicts }, cmds];
}

/** The machine. Every cell is yours; each one calls a plain function of the knob. */
export function expenseMachine(ask: Ask) {
  return defineMachine({
    types: {
      model: {} as ExpenseState,
      msg: {} as ExpenseMsg,
      ctx: undefined,
    },
    // The knob's run Cmd: the engine turns its handler's outcome into
    // `resilient_run_ok` / `resilient_run_err`.
    cmds: [ask.run],
    init: (loaded) =>
      loaded !== null
        ? [loaded, []]
        : [{ resilience: ask.init(), verdicts: {} }, []],
    update: {
      classify: (s, m) =>
        settle(s, m.key, ask.attempt(s.resilience, m.key, m.memo, m.at)),
      resilient_run_ok: (s, m) =>
        settle(s, m.cmd.key, ask.succeed(s.resilience, m)),
      resilient_run_err: (s, m) =>
        settle(s, m.cmd.key, ask.fail(s.resilience, m)),
      // A retry fires, or a deadline settles a call `failed` in the slice.
      deadline_exceeded: (s, m) => {
        const [resilience, cmds] = ask.onTimer(s.resilience, m);
        const verdicts = { ...s.verdicts };
        for (const key of Object.keys(resilience.calls)) {
          const verdict = verdictOf(resilience.calls[key]);
          if (verdict !== undefined) verdicts[key] = verdict;
        }
        return [{ resilience, verdicts }, cmds];
      },
    },
    // The retry timer. `timer` is built into the engine.
    subs: [
      { type: "timer", deps: (s: ExpenseState) => ask.timer(s.resilience) },
    ],
  });
}
```

The state stays yours
([ADR 0015](../../../../.decisions/0015-hide-the-wiring-never-the-state.md)):
`resilience` is a plain field you read, `replay` sees and the journal prints.

## 3. Write the handler — or don't call Jev at all

The HTTP call is the one handler you write. The door holds no API key and reads
no environment variable: your handler owns the `Authorization` header. It hands
Jev's reply to `ask.decode`, which returns the outcome, and `ask.rejected` when
the call itself threw. That split is what lets a test swap the network for a
function of the same type.

```ts
import type { Interpret } from "@demlik/tea";
import type { JevHttpReply } from "@demlik/tea/jev";

/** One HTTP call to Jev, as the handler sees it: a request in, a reply out. */
export type CallJev = (request: JevRequest<Questions>) => Promise<JevHttpReply>;

/**
 * The one handler the machine needs. It calls Jev and hands the reply to
 * `ask.decode`, which returns the outcome. With no `callJev` — no key — it
 * answers from the fallback instead.
 */
export function jevHandler(
  ask: Ask,
  callJev?: CallJev,
): Interpret<ExpenseMsg, JevCmd<Questions>, unknown> {
  return {
    resilient_run: async (cmd) => {
      if (callJev === undefined) return ask.offline(cmd.input);
      try {
        return ask.decode(cmd.input, await callJev(cmd.input));
      } catch (cause) {
        return ask.rejected(cause);
      }
    },
  };
}

/**
 * Jev, scripted. The same `CallJev` a `fetch` adapter satisfies, so the
 * machine under test is the machine that ships — and no key, clock or socket
 * is anywhere on the path, which is what keeps the run replayable.
 */
export function fakeJev(
  script: readonly (readonly [Category, number])[],
): CallJev {
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

Configure `fallback` on the knob, and a handler with no key answers from it
with `ask.offline`. The knob also asks it when the retry budget is spent. It
must be pure, because that path runs it inside the `fail` verb.

## 4. Drive it in a test

`drive` from [`@demlik/tea/testing`](../reference/testing.md) runs the machine
the way the runtime does. It folds the Msg, hands every emitted Cmd to the real
handler, turns each outcome into its settle Msg, feeds it back, and stops when
the machine is quiet. There is no runtime, no clock and no socket anywhere on
the path. It returns the settled `state` **and** the `trace`: every Cmd
dispatched and every Msg folded, in order.

```ts
import { drive } from "@demlik/tea/testing";

/**
 * Feed one `classify` and let `drive` do what the runtime does: run the real
 * handler over every Cmd, turn each outcome into its settle Msg and feed it
 * back, and stop when the machine is quiet. It returns the settled state AND
 * the `trace` — every Cmd dispatched and every Msg folded, in order.
 */
export function classifyOne(
  ask: Ask,
  callJev: CallJev | undefined,
  key: string,
  memo: string,
) {
  return drive(
    expenseMachine(ask),
    { resilience: ask.init(), verdicts: {} },
    { type: "classify", key, memo, at: 0 },
    jevHandler(ask, callJev),
  );
}
```

The handler is the same table a host hands `run`, so the test drives the
**real** handler and fakes only the HTTP call beneath it. A machine that never
settles is a throw (`DriveRoundsExceededError`, carrying the partial trace),
never a half-driven state handed back as if it were done.

Then the assertions are plain data, and the `trace` answers questions the
settled state cannot:

```ts
const ask = createJevAsk({ questions });
const { state, trace } = await classifyOne(
  ask,
  fakeJev([["dining", 0.93]]),
  "tx-1",
  "PIZZA NAPOLI 24.10 EUR",
);
expect(state.verdicts["tx-1"]).toEqual({ kind: "booked", category: "dining" });
// Jev was asked EXACTLY once, so this is a first-attempt answer and not the
// end of a retry ladder.
expect(trace.filter((entry) => entry.kind === "cmd")).toHaveLength(1);
```

Swap `0.93` for `0.41` and the same machine returns
`{ kind: "triage", why: "confidence 0.41" }`. That is the threshold branch,
exercised without a single mock of the door itself.

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
