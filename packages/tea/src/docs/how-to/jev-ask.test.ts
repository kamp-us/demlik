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
 * artifact. The last region is driven through `@demlik/tea/testing/promise`'s `drive`
 * against a scripted Jev, so the recipe is proven to RUN and not only to
 * compile.
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
// #endregion machine

// #region handler
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
// #endregion handler

// #region drive
import { drive } from "@demlik/tea/testing/promise";

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
// #endregion drive

describe("docs/how-to/ask-jev-a-typed-question.md (#219) — it runs", () => {
  it("books a confident answer under its narrowed category", async () => {
    const ask = createJevAsk({ questions });
    const { state, trace } = await classifyOne(
      ask,
      fakeJev([["dining", 0.93]]),
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
    const ask = createJevAsk({ questions });
    const { state } = await classifyOne(
      ask,
      fakeJev([["transport", 0.41]]),
      "tx-2",
      "SQ *UNKNOWN 8.00 EUR",
    );
    expect(state.verdicts["tx-2"]).toEqual({
      kind: "triage",
      why: "confidence 0.41",
    });
  });

  it("answers from the fallback when the handler has no key", async () => {
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
    const { state } = await classifyOne(
      ask,
      undefined,
      "tx-3",
      "SUPERMARKET 12.00 EUR",
    );
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
    "handler",
    "drive",
  ])("shows the compiled `%s` block verbatim", async (name) => {
    expect(await tsBlocks()).toContain(await region(name));
  });
});
