/**
 * Three named Jev knobs in one machine, on the Effect engine (#576).
 *
 * Each knob has its own question map and its own name, so each has its own run
 * Cmd, settle Msgs and timer Msg. The handler map below has one cell per knob
 * and no cast, and every `<name>_run_ok` cell reads `m.value` at its own
 * knob's `JevOk`.
 *
 * The engine runs one handler at a time, so the three calls overlap in the
 * slices: each is rate-limited once and waits on its retry timer under the
 * same key, and all three wait together before any timer fires.
 *
 * It lives under `src/effect/` because it imports `effect`, which only this
 * entry may do.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { defineMachine, type Outcome } from "../index";
import {
  createJevAsk,
  type JevHttpReply,
  type JevOk,
  type JevRequest,
  type JevTimerMsg,
  jevQuestions,
  type ResilientState,
} from "../jev";
import { run } from "./index";

const judgeQuestions = jevQuestions({
  verdict: {
    type: "choice",
    instructions: "Does the diff meet the acceptance criteria?",
    criteria: { pass: "Every criterion is met", fail: "One is not" },
  },
});
const sortQuestions = jevQuestions({
  kind: {
    type: "choice",
    instructions: "What kind of issue is this?",
    criteria: { bug: "A defect", feature: "New behavior", chore: "Upkeep" },
  },
});
const sizeQuestions = jevQuestions({
  appetite: {
    type: "choice",
    instructions: "How big is the work?",
    criteria: { small: "A day", large: "A week" },
  },
});
type JudgeQuestions = typeof judgeQuestions;
type SortQuestions = typeof sortQuestions;
type SizeQuestions = typeof sizeQuestions;

const retry = {
  baseMs: 100,
  factor: 2,
  capMs: 10_000,
  maxAttempts: 3,
  jitter: "full" as const,
};
// rng pinned to 0 collapses the backoff delay to 0, so `retryAtMs` is exact.
const rngZero = () => 0;

const judge = createJevAsk(
  { questions: judgeQuestions, name: "judge", retry },
  rngZero,
);
const sort = createJevAsk(
  { questions: sortQuestions, name: "sort", retry },
  rngZero,
);
const size = createJevAsk(
  { questions: sizeQuestions, name: "size", retry },
  rngZero,
);

interface State {
  readonly judge: ResilientState<
    JevRequest<JudgeQuestions>,
    JevOk<JudgeQuestions>
  >;
  readonly sort: ResilientState<
    JevRequest<SortQuestions>,
    JevOk<SortQuestions>
  >;
  readonly size: ResilientState<
    JevRequest<SizeQuestions>,
    JevOk<SizeQuestions>
  >;
}

type Msg =
  | { readonly type: "ask_all"; readonly content: string }
  | JevTimerMsg<"judge">
  | JevTimerMsg<"sort">
  | JevTimerMsg<"size">;

const machine = defineMachine({
  types: { model: {} as State, msg: {} as Msg, ctx: undefined },
  cmds: [judge.run, sort.run, size.run],
  init: (loaded) =>
    loaded !== null
      ? [loaded, []]
      : [{ judge: judge.init(), sort: sort.init(), size: size.init() }, []],
  update: {
    // One key for all three: the knob's name is what keeps them apart.
    ask_all: (s, m) => {
      const [judged, judgeCmds] = judge.attempt(s.judge, "k", m.content, 0);
      const [sorted, sortCmds] = sort.attempt(s.sort, "k", m.content, 0);
      const [sized, sizeCmds] = size.attempt(s.size, "k", m.content, 0);
      return [
        { judge: judged, sort: sorted, size: sized },
        [...judgeCmds, ...sortCmds, ...sizeCmds],
      ];
    },
    judge_run_ok: (s, m) => {
      const value: JevOk<JudgeQuestions> = m.value;
      // @ts-expect-error — the judge's answer is not the sorter's.
      const wrong: JevOk<SortQuestions> = m.value;
      void [value, wrong];
      const [slice, cmds] = judge.succeed(s.judge, m);
      return [{ ...s, judge: slice }, cmds];
    },
    judge_run_err: (s, m) => {
      const [slice, cmds] = judge.fail(s.judge, m);
      return [{ ...s, judge: slice }, cmds];
    },
    judge_deadline: (s, m) => {
      const [slice, cmds] = judge.onTimer(s.judge, m);
      return [{ ...s, judge: slice }, cmds];
    },
    sort_run_ok: (s, m) => {
      const value: JevOk<SortQuestions> = m.value;
      void value;
      const [slice, cmds] = sort.succeed(s.sort, m);
      return [{ ...s, sort: slice }, cmds];
    },
    sort_run_err: (s, m) => {
      const [slice, cmds] = sort.fail(s.sort, m);
      return [{ ...s, sort: slice }, cmds];
    },
    sort_deadline: (s, m) => {
      const [slice, cmds] = sort.onTimer(s.sort, m);
      return [{ ...s, sort: slice }, cmds];
    },
    size_run_ok: (s, m) => {
      const value: JevOk<SizeQuestions> = m.value;
      void value;
      const [slice, cmds] = size.succeed(s.size, m);
      return [{ ...s, size: slice }, cmds];
    },
    size_run_err: (s, m) => {
      const [slice, cmds] = size.fail(s.size, m);
      return [{ ...s, size: slice }, cmds];
    },
    size_deadline: (s, m) => {
      const [slice, cmds] = size.onTimer(s.size, m);
      return [{ ...s, size: slice }, cmds];
    },
  },
});

/** A handler's `Outcome` as the Effect a cell returns. */
function settled<A, E>(outcome: Outcome<A, E>): Effect.Effect<A, E> {
  return outcome._tag === "Ok"
    ? Effect.succeed(outcome.value)
    : Effect.fail(outcome.error);
}

/** Jev's reply to one choice question: `choice` wins among `keys`. */
function choiceReply(
  id: string,
  keys: readonly string[],
  choice: string,
): JevHttpReply {
  const rest = 0.1 / (keys.length - 1);
  return {
    status: 200,
    body: {
      model: "jev-1",
      answers: {
        [id]: {
          type: "choice",
          choice,
          confidence: 0.9,
          probabilities: Object.fromEntries(
            keys.map((key) => [key, key === choice ? 0.9 : rest]),
          ),
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}

/** A scripted Jev: a 429 on the first call, then `reply`. */
function rateLimitedOnce(reply: JevHttpReply): () => JevHttpReply {
  let calls = 0;
  return () => {
    calls += 1;
    return calls === 1 ? { status: 429, body: {} } : reply;
  };
}

describe("three named Jev knobs in one machine, on the Effect engine", () => {
  it("keeps three overlapping calls apart and settles each answer into its own knob's slice", async () => {
    const jev = {
      judge: rateLimitedOnce(choiceReply("verdict", ["pass", "fail"], "fail")),
      sort: rateLimitedOnce(
        choiceReply("kind", ["bug", "feature", "chore"], "chore"),
      ),
      size: rateLimitedOnce(
        choiceReply("appetite", ["small", "large"], "small"),
      ),
    };

    const { waiting, state } = await Effect.runPromise(
      Effect.gen(function* () {
        const handle = yield* run(machine, {
          ctx: undefined,
          clock: () => 0,
          interpret: {
            judge_run: (cmd) => settled(judge.decode(cmd.input, jev.judge())),
            sort_run: (cmd) => settled(sort.decode(cmd.input, jev.sort())),
            size_run: (cmd) => settled(size.decode(cmd.input, jev.size())),
          },
        });
        const runtime = yield* handle.ready;

        yield* runtime.dispatch({ type: "ask_all", content: "an issue" });
        const waiting = runtime.getState();

        // Fired in a different order than asked. Every id ends in the same
        // key, so only the name routes a timer to its knob.
        yield* runtime.dispatch({
          type: "size_deadline",
          id: "size:retry:k",
          atMs: 0,
        });
        yield* runtime.dispatch({
          type: "judge_deadline",
          id: "judge:retry:k",
          atMs: 0,
        });
        yield* runtime.dispatch({
          type: "sort_deadline",
          id: "sort:retry:k",
          atMs: 0,
        });
        return { waiting, state: runtime.getState() };
      }).pipe(Effect.scoped),
    );

    expect(waiting.judge.calls.k?.phase).toBe("waiting_retry");
    expect(waiting.sort.calls.k?.phase).toBe("waiting_retry");
    expect(waiting.size.calls.k?.phase).toBe("waiting_retry");
    expect(judge.timer(waiting.judge)?.msg.type).toBe("judge_deadline");
    expect(sort.timer(waiting.sort)?.msg.type).toBe("sort_deadline");
    expect(size.timer(waiting.size)?.msg.type).toBe("size_deadline");

    const judged = state.judge.calls.k;
    const sorted = state.sort.calls.k;
    const sized = state.size.calls.k;
    if (
      judged?.phase !== "succeeded" ||
      sorted?.phase !== "succeeded" ||
      sized?.phase !== "succeeded"
    ) {
      throw new Error("expected all three calls to succeed");
    }
    // The annotations are assertions: each answer is typed by its own knob's
    // question map, and a wider type would not compile.
    const verdict: "pass" | "fail" = judged.result.answers.verdict.choice;
    const kind: "bug" | "feature" | "chore" = sorted.result.answers.kind.choice;
    const appetite: "small" | "large" = sized.result.answers.appetite.choice;
    expect([verdict, kind, appetite]).toEqual(["fail", "chore", "small"]);
  });
});
