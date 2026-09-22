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
 * artifact. The last region is driven through `replay`'s bound `step` against a
 * fake port, so the recipe is proven to RUN and not only to compile.
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
// #endregion drive

describe("docs/how-to/ask-jev-a-typed-question.md (#219) — it runs", () => {
  it("books a confident answer under its narrowed category", async () => {
    const ask = createJevAsk({
      questions,
      port: fakeJev([["dining", 0.93]]),
    });
    const state = await classifyOne(ask, "tx-1", "PIZZA NAPOLI 24.10 EUR");
    expect(state.verdicts["tx-1"]).toEqual({
      kind: "booked",
      category: "dining",
    });
  });

  it("sends a low-confidence answer to triage instead of booking it", async () => {
    const ask = createJevAsk({
      questions,
      port: fakeJev([["transport", 0.41]]),
    });
    const state = await classifyOne(ask, "tx-2", "SQ *UNKNOWN 8.00 EUR");
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
    const state = await classifyOne(ask, "tx-3", "SUPERMARKET 12.00 EUR");
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
