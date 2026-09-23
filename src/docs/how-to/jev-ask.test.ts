/**
 * The jev-ask recipe's compile-and-run gate (#219).
 *
 * `docs/how-to/ask-jev-a-typed-question.md` hands the reader a machine to
 * paste. The claim it makes is a TYPE claim — that a choice question's criteria
 * keys arrive at the call site as the answer's `choice` union, so the
 * confidence branch books a `Category` and never a `string` — and a page that
 * nothing compiles cannot keep it: `choice` widening to `string` is exactly the
 * drift a reader would not notice until their own `switch` stopped being
 * exhaustive.
 *
 * So the machine lives HERE, as real TypeScript in the test program
 * (`tsconfig.test.json`, gated in CI as `typecheck:test`), and the tests below
 * assert the page's `ts` blocks are this file's `#region` bodies verbatim. The
 * page cannot drift from a compiling artifact, because the page IS the
 * artifact. The last region is driven through `@demlik/tea/testing`'s `drive`
 * against a fake port, so the recipe is proven to RUN and not only to compile.
 */

// biome-ignore-all assist/source/organizeImports: the `#region` markers below
// pin import blocks the page reproduces verbatim; sorting the harness's imports
// into them would move a marker and break the assertions this file is.
// biome-ignore-all lint/suspicious/noExportsInTest: the machine is the artifact
// under test, and it is exported because the reader pastes it as a module.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #region questions
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
// #endregion questions

// #region machine
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
 * ALREADY settled, so there is no cell to put in the wrong order, and
 * `subscribe` / `interpret` ride along on the fragments rather than being
 * remembered — `subscribe` into the machine, `interpret` to `run` beside it.
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
    subscriptions: mounted.subscriptions,
    subscribe: mounted.subscribe,
  });
  return { machine, interpret: mounted.interpret };
}
// #endregion machine

// #region fake
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
// #endregion fake

// #region drive
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
// #endregion drive

describe("docs/how-to/ask-jev-a-typed-question.md (#219) — it runs", () => {
  it("books a confident answer under its narrowed category", async () => {
    const ask = createJevAsk({
      questions,
      port: fakeJev([["dining", 0.93]]),
    });
    const { state, trace } = await classifyOne(
      ask,
      "tx-1",
      "PIZZA NAPOLI 24.10 EUR",
    );
    expect(state.verdicts["tx-1"]).toEqual({
      kind: "booked",
      category: "dining",
    });
    // The trace is what the loop could not express: the door was asked EXACTLY
    // once, so the booked verdict is a first-attempt answer and not a retry.
    expect(trace.filter((entry) => entry.kind === "cmd")).toHaveLength(1);
  });

  it("sends a low-confidence answer to triage instead of booking it", async () => {
    const ask = createJevAsk({
      questions,
      port: fakeJev([["transport", 0.41]]),
    });
    const { state } = await classifyOne(ask, "tx-2", "SQ *UNKNOWN 8.00 EUR");
    expect(state.verdicts["tx-2"]).toEqual({
      kind: "triage",
      why: "confidence 0.41",
    });
  });

  it("answers from the fallback when no port is configured", async () => {
    const ask = createJevAsk({
      questions,
      fallback: () => ({
        category: {
          type: "choice" as const,
          choice: "groceries" as const,
          confidence: 1,
          probabilities: { groceries: 1, dining: 0, transport: 0 },
        },
      }),
    });
    const { state } = await classifyOne(ask, "tx-3", "SUPERMARKET 12.00 EUR");
    expect(state.verdicts["tx-3"]).toEqual({
      kind: "booked",
      category: "groceries",
    });
  });
});

const page = fileURLToPath(
  new URL("../../../docs/how-to/ask-jev-a-typed-question.md", import.meta.url),
);
const self = fileURLToPath(import.meta.url);

/** The text between one region's markers, which is what the page shows. */
async function region(name: string): Promise<string> {
  const source = await readFile(self, "utf8");
  const body = source
    .split(`// #region ${name}\n`)[1]
    ?.split(`// #endregion ${name}\n`)[0];
  if (body === undefined)
    throw new Error(`the ${name} region markers are gone`);
  return body.trimEnd();
}

/** Every fenced ```ts block on the page, in page order. */
async function tsBlocks(): Promise<string[]> {
  const markdown = await readFile(page, "utf8");
  return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) =>
    (m[1] ?? "").trimEnd(),
  );
}

describe("docs/how-to/ask-jev-a-typed-question.md (#219) — it cannot rot", () => {
  it.each([
    "questions",
    "machine",
    "fake",
    "drive",
  ])("shows the compiled `%s` block verbatim", async (name) => {
    expect(await tsBlocks()).toContain(await region(name));
  });
});
