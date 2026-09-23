// Expense triage over `@demlik/tea/jev`: one choice question, answered per
// transaction, booked automatically when the model is confident and queued for
// a human when it is not.
//
// This file exists to be COMPILED the way an installer compiles it —
// `tsconfig.consumers.json` resolves these specifiers against `dist`, not
// `src`, so an export map that resolves internally and not from outside fails
// here rather than in someone's project.
import { defineMachine, type Reducer } from "@demlik/tea";
import { run } from "@demlik/tea/promise";
import {
  createJevAsk,
  deadlinesSub,
  type JevCmd,
  type JevFailMsg,
  type JevOk,
  type JevPort,
  type JevRequest,
  type JevSub,
  type JevSucceedMsg,
  type JevTimerMsg,
  jevQuestions,
  liftJevAsk,
  type ResilientState,
  subscribeDeadline,
} from "@demlik/tea/jev";

// ---------------------------------------------------------------------------
// The rubric. Its keys are the answer's `choice` domain — `Category` below is
// derived from it, so an option added here widens every exhaustive read.
// ---------------------------------------------------------------------------

const questions = jevQuestions({
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

type Questions = typeof questions;
type Category = keyof Questions["category"]["criteria"];

// ---------------------------------------------------------------------------
// State, Msgs, Cmds.
// ---------------------------------------------------------------------------

/** Where one expense ended up. `triage` is a human's queue, not a category. */
type Verdict =
  | { readonly kind: "booked"; readonly category: Category }
  | { readonly kind: "triage"; readonly why: string };

interface State {
  /** The knob's slice — resilient-call's, so a rehydrate costs nothing. */
  readonly resilience: ResilientState<JevRequest<Questions>, JevOk<Questions>>;
  readonly verdicts: Readonly<Record<string, Verdict>>;
}

type Msg =
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

/** Below this the answer goes to a human. The threshold is the HOST's rule. */
const CONFIDENCE_FLOOR = 0.8;

// ---------------------------------------------------------------------------
// The reducer. Every arm runs the knob's inherited verb FIRST so the backoff
// loop advances, then folds this machine's own state around the result.
// ---------------------------------------------------------------------------

function update(ask: Ask): Reducer<State, Msg, JevCmd<Questions>> {
  return {
    classify: (s, m) =>
      liftJevAsk(s, ask.attempt(s.resilience, m.key, m.memo, m.at)),

    resilient_ok: (s, m) => {
      const [slice, cmds] = ask.succeed(s.resilience, m.key, m);
      const answer = m.result.answers.category;
      // `answer.choice` is `Category`, not `string` — the whole point of the
      // rubric being a value the compiler can read.
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
  };
}

function expenseMachine(ask: Ask) {
  return defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      cmd: {} as JevCmd<Questions>,
      sub: {} as JevSub,
      ctx: undefined,
    },
    init: (loaded) =>
      loaded !== null
        ? [loaded, []]
        : [{ resilience: ask.init(), verdicts: {} }, []],
    update: update(ask),
    subs: [deadlinesSub((s: State) => ask.subs(s.resilience))],
  });
}

// ---------------------------------------------------------------------------
// The one seam that touches the network. The door holds no key: this closure
// does, which is what lets a test hand the same type a scripted function.
// ---------------------------------------------------------------------------

export function fetchJevPort(apiKey: string): JevPort<Questions> {
  return async (request, signal) => {
    const response = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    });
    return { status: response.status, body: await response.json() };
  };
}

/**
 * The same type, scripted. `main` below uses this one so the example runs
 * offline and deterministically; swap in `fetchJevPort(key)` and nothing else
 * in this file changes, which is the property the port seam buys.
 */
function scriptedJevPort(
  answers: Readonly<Record<string, readonly [Category, number]>>,
): JevPort<Questions> {
  return async (request) => {
    const memo = String(request.state);
    const hit = Object.entries(answers).find(([needle]) =>
      memo.includes(needle),
    );
    if (hit === undefined) return { status: 422, body: {} };
    const [choice, confidence] = hit[1];
    return {
      status: 200,
      body: {
        model: request.model,
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

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------

const EXPENSES = [
  { id: "tx-1", memo: "PIZZA NAPOLI 24.10 EUR" },
  { id: "tx-2", memo: "SUPERMARKT ALBERT 61.40 EUR" },
  { id: "tx-3", memo: "SQ *UNMARKED 8.00 EUR" },
  { id: "tx-4", memo: "NOTHING THE RUBRIC COVERS" },
] as const;

async function main() {
  const ask = createJevAsk({
    questions,
    port: scriptedJevPort({
      PIZZA: ["dining", 0.93],
      SUPERMARKT: ["groceries", 0.88],
      UNMARKED: ["transport", 0.41],
    }),
    retry: {
      baseMs: 200,
      factor: 2,
      capMs: 10_000,
      maxAttempts: 4,
      jitter: "full",
    },
  });

  // The machine is data; the handlers ride beside it into `run`.
  const runtime = await run(expenseMachine(ask), {
    ctx: undefined,
    interpret: ask.handlers(),
    subscribe: { deadline: subscribeDeadline },
  }).ready;

  for (const expense of EXPENSES) {
    runtime.dispatch({
      type: "classify",
      key: expense.id,
      memo: expense.memo,
      at: Date.now(),
    });
  }

  const settled = new Promise<void>((resolve) => {
    const off = runtime.subscribe(() => {
      if (Object.keys(runtime.getState().verdicts).length === EXPENSES.length) {
        off();
        resolve();
      }
    });
  });
  await settled;

  console.log("triage:");
  for (const expense of EXPENSES) {
    const verdict = runtime.getState().verdicts[expense.id];
    const line =
      verdict === undefined
        ? "?"
        : verdict.kind === "booked"
          ? `booked   ${verdict.category}`
          : `triage   ${verdict.why}`;
    console.log(`  ${expense.id}  ${line}`);
  }

  await runtime.stop();
}

main();
