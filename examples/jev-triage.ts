// Expense triage over `@demlik/tea/jev`: one choice question, answered per
// transaction, booked automatically when the model is confident and queued for
// a human when it is not.
//
// This file exists to be COMPILED the way an installer compiles it —
// `tsconfig.consumers.json` resolves these specifiers against `dist`, not
// `src`, so an export map that resolves internally and not from outside fails
// here rather than in someone's project.
import { defineMachine, type Interpret } from "@demlik/tea";
import { run } from "@demlik/tea/promise";
import {
  createJevAsk,
  type JevCmd,
  type JevHttpReply,
  type JevOk,
  type JevRequest,
  type JevTimerMsg,
  jevQuestions,
  type ResilientState,
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
  | JevTimerMsg;

type Ask = ReturnType<typeof createJevAsk<Questions>>;
type Call = State["resilience"]["calls"][string];

/** Below this the answer goes to a human. The threshold is the HOST's rule. */
const CONFIDENCE_FLOOR = 0.8;

// ---------------------------------------------------------------------------
// The machine. Every cell runs the knob's verb FIRST so the backoff loop
// advances, then reads the verdict off the slice it settled.
// ---------------------------------------------------------------------------

/**
 * The verdict a settled call earns. `answer.choice` is `Category`, not
 * `string` — the whole point of the rubric being a value the compiler can
 * read. A call still backing off has none yet.
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

/** Put the knob's settled slice back, with every verdict it now holds. */
function settle(
  s: State,
  [resilience, cmds]: readonly [
    State["resilience"],
    readonly JevCmd<Questions>[],
  ],
): readonly [State, readonly JevCmd<Questions>[]] {
  const verdicts = { ...s.verdicts };
  for (const [key, call] of Object.entries(resilience.calls)) {
    const verdict = verdictOf(call);
    if (verdict !== undefined) verdicts[key] = verdict;
  }
  return [{ resilience, verdicts }, cmds];
}

function expenseMachine(ask: Ask) {
  return defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      ctx: undefined,
    },
    // The ask Cmd: the engine turns the handler's outcome into
    // `resilient_run_ok` / `resilient_run_err`.
    cmds: [ask.run],
    init: (loaded) =>
      loaded !== null
        ? [loaded, []]
        : [{ resilience: ask.init(), verdicts: {} }, []],
    update: {
      classify: (s, m) =>
        settle(s, ask.attempt(s.resilience, m.key, m.memo, m.at)),
      resilient_run_ok: (s, m) => settle(s, ask.succeed(s.resilience, m)),
      resilient_run_err: (s, m) => settle(s, ask.fail(s.resilience, m)),
      deadline_exceeded: (s, m) => settle(s, ask.onTimer(s.resilience, m)),
    },
    // The retry timer. `timer` is built into the engine.
    subs: [{ type: "timer", deps: (s: State) => ask.timer(s.resilience) }],
  });
}

// ---------------------------------------------------------------------------
// The one seam that touches the network: the handler you write. The door holds
// no key — this closure does, which is what lets a test hand the same type a
// scripted function.
// ---------------------------------------------------------------------------

/** One HTTP call to Jev: a request in, the undecoded reply out. */
type CallJev = (request: JevRequest<Questions>) => Promise<JevHttpReply>;

export function fetchJev(apiKey: string): CallJev {
  return async (request) => {
    const response = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
    return { status: response.status, body: await response.json() };
  };
}

/** The handler: call Jev, and let the knob's `decode` build the outcome. */
function jevHandler(
  ask: Ask,
  callJev: CallJev,
): Interpret<Msg, JevCmd<Questions>, unknown> {
  return {
    resilient_run: async (cmd) => {
      try {
        return ask.decode(cmd.input, await callJev(cmd.input));
      } catch (cause) {
        return ask.rejected(cause);
      }
    },
  };
}

/**
 * The same type, scripted. `main` below uses this one so the example runs
 * offline and deterministically; swap in `fetchJev(key)` and nothing else
 * in this file changes, which is the property the handler seam buys.
 */
function scriptedJev(
  answers: Readonly<Record<string, readonly [Category, number]>>,
): CallJev {
  return async (request) => {
    const memo = String(request.state);
    const hit = Object.entries(answers).find(([needle]) =>
      memo.includes(needle),
    );
    if (hit === undefined) return { status: 422, body: {} };
    const [choice, confidence] = hit[1];
    // `probabilities` is TOTAL over the criteria keys on the wire: spread the
    // remaining mass over the other two and let the winner overwrite its own.
    const rest = (1 - confidence) / 2;
    return {
      status: 200,
      body: {
        model: request.model,
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
    retry: {
      baseMs: 200,
      factor: 2,
      capMs: 10_000,
      maxAttempts: 4,
      jitter: "full",
    },
  });

  // The machine is data; the handler rides beside it into `run`.
  const runtime = await run(expenseMachine(ask), {
    ctx: undefined,
    interpret: jevHandler(
      ask,
      scriptedJev({
        PIZZA: ["dining", 0.93],
        SUPERMARKT: ["groceries", 0.88],
        UNMARKED: ["transport", 0.41],
      }),
    ),
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
