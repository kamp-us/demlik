import { describe, expect, it, vi } from "vitest";
import { defineMachine, type Reducer } from "../../../index";
import { bindMachine } from "../../../testing";
import {
  type JevAnswers,
  type JevErr,
  type JevRequest,
  jevQuestions,
} from "../protocol";
import {
  createJevAsk,
  type DeadlineSub,
  deadlineSub,
  type JevAskCmd,
  type JevAskErr,
  type JevFailMsg,
  type JevOk,
  type JevPort,
  type JevSucceedMsg,
  type JevTimerMsg,
  jevAskCmdDef,
  type ResilientState,
} from "./index";

// ---------------------------------------------------------------------------
// Fixtures — one choice question, so the answer's `choice` domain IS the
// criteria keys and the typing claim is checkable at the call site.
// ---------------------------------------------------------------------------

const questions = jevQuestions({
  category: {
    type: "choice",
    instructions: "Which budget line is this?",
    criteria: { groceries: "Supermarkets", dining: "Restaurants" },
  },
});
type Questions = typeof questions;

const okBody = {
  model: "jev-1",
  answers: {
    category: {
      type: "choice",
      choice: "dining",
      probabilities: { groceries: 0.1, dining: 0.9 },
      confidence: 0.9,
    },
  },
  usage: { input_tokens: 11, output_tokens: 3 },
};

/** A port that pops one scripted `[status, body]` per call and counts its calls. */
function scriptedPort(script: readonly (readonly [number, unknown])[]) {
  const calls: number[] = [];
  const queue = [...script];
  const port: JevPort<Questions> = async () => {
    const next = queue.shift() ?? ([200, okBody] as const);
    calls.push(next[0]);
    return { status: next[0], body: next[1] };
  };
  return { port, calls };
}

// rng pinned to 0 → "full" jitter collapses the backoff delay to 0, so
// `retryAtMs === at` and every timer target in an assertion is exact.
const rngZero = () => 0;

const retry = {
  baseMs: 100,
  factor: 2,
  capMs: 10_000,
  maxAttempts: 3,
  jitter: "full" as const,
};

// ---------------------------------------------------------------------------
// The host machine — the knob spliced into a reducer exactly as its docblock
// wires it. `drive` runs the REAL interpret handler between steps, so the port
// is actually called and the settle Msg re-enters through `replay`.
// ---------------------------------------------------------------------------

interface HostState {
  readonly resilience: ResilientState<JevRequest<Questions>, JevOk<Questions>>;
}
type HostMsg =
  | { type: "ask"; key: string; content: string; at: number }
  | JevSucceedMsg<Questions>
  | JevFailMsg
  | JevTimerMsg;

/** The knob, as the host sees it. */
type Ask = ReturnType<typeof createJevAsk<Questions>>;
type HostCmd = JevAskCmd<Questions>;

/** The host reducer the module docblock wires — every arm is the knob's verb. */
function hostUpdate(ask: Ask): Reducer<HostState, HostMsg, HostCmd> {
  return {
    ask: (s, m) => {
      const [slice, cmds] = ask.attempt(s.resilience, m.key, m.content, m.at);
      return [{ resilience: slice }, cmds];
    },
    resilient_ok: (s, m) => {
      const [slice, cmds] = ask.succeed(s.resilience, m.key, m);
      return [{ resilience: slice }, cmds];
    },
    resilient_err: (s, m) => {
      const [slice, cmds] = ask.fail(s.resilience, m.key, m);
      return [{ resilience: slice }, cmds];
    },
    deadline_exceeded: (s, m) => {
      const [slice, cmds] = ask.onTimer(s.resilience, m);
      return [{ resilience: slice }, cmds];
    },
  };
}

function hostMachine(ask: Ask) {
  return defineMachine<HostState, HostMsg, HostCmd, DeadlineSub, undefined>({
    types: {
      model: {} as HostState,
      msg: {} as HostMsg,
      cmd: {} as HostCmd,
      sub: {} as DeadlineSub,
      ctx: undefined,
    },
    init: (loaded) =>
      loaded !== null ? [loaded, []] : [{ resilience: ask.init() }, []],
    update: hostUpdate(ask),
    subscriptions: (s) => ask.subs(s.resilience),
    subscribe: { deadline: () => () => {} },
    interpret: ask.handlers(),
  });
}

/** The call phase under `key`, refusing the "no such call" read outright. */
function callOf(state: HostState, key = "k") {
  const call = state.resilience.calls[key];
  if (call === undefined) throw new Error(`no call under ${key}`);
  return call;
}

/**
 * Drive one call to its fixed point through `replay`'s bound `step`: feed the
 * Msg, run the real handler over every Cmd the reducer emitted, feed the settle
 * Msg back, and fire a retry timer by hand whenever the slice is waiting for
 * one. Returns the final host state.
 */
async function drive(
  ask: Ask,
  key: string,
  content: string,
): Promise<HostState> {
  const bound = bindMachine(hostMachine(ask), undefined);
  let [state, cmds] = bound.step(
    { resilience: ask.init() },
    {
      type: "ask",
      key,
      content,
      at: 0,
    },
  );
  for (let guard = 0; guard < 20; guard += 1) {
    for (const cmd of cmds) {
      const settle = await ask.handlers().resilient_run(cmd);
      [state, cmds] = bound.step(state, settle);
    }
    if (cmds.length > 0) continue;
    const call = callOf(state, key);
    if (call.phase !== "waiting_retry") return state;
    [state, cmds] = bound.step(state, {
      type: "deadline_exceeded",
      id: `resilient:retry:${key}`,
      atMs: call.retryAtMs,
    });
  }
  throw new Error("drive: did not settle");
}

// ---------------------------------------------------------------------------

describe("createJevAsk — the slice and verbs are resilient-call's", () => {
  const ask = createJevAsk<Questions>({ questions, retry }, rngZero);

  it("exposes the knob contract and inherits the resilient slice", () => {
    expect(Object.keys(ask).sort()).toEqual([
      "ask",
      "attempt",
      "fail",
      "handlers",
      "init",
      "name",
      "onTimer",
      "subs",
      "succeed",
    ]);
    const s = ask.init();
    expect(s.calls).toEqual({});
    expect(s.circuit).toEqual({ phase: "closed", failures: 0 });
    expect(s.retry).toEqual({});
  });

  it("attempt emits the declared resilient_run Cmd carrying the plain request", () => {
    const [s, cmds] = ask.attempt(ask.init(), "k", "a receipt", 0);
    expect(cmds).toEqual([
      {
        type: jevAskCmdDef<Questions>().cmdType,
        key: "k",
        input: { state: "a receipt", model: "jev-latest", questions },
      },
    ]);
    expect(s.calls.k).toEqual({
      phase: "running",
      input: { state: "a receipt", model: "jev-latest", questions },
      budget: { remainingMs: 0, chargingSinceMs: 0 },
    });
  });

  it("succeed / onTimer / subs are resilient-call's verbs, not a second loop", () => {
    const result: JevOk<Questions> = {
      answers: okBody.answers as unknown as JevAnswers<Questions>,
      model: "jev-1",
      usage: { input_tokens: 1, output_tokens: 1 },
      source: "port",
    };
    let s = ask.init();
    [s] = ask.attempt(s, "k", "x", 0);
    [s] = ask.succeed(s, "k", {
      type: "resilient_ok",
      key: "k",
      result,
      at: 0,
    });
    expect(s.calls.k).toEqual({ phase: "succeeded", result });
    expect(ask.subs(s)).toEqual([]);

    // A transient failure arms the inherited retry timer; onTimer re-issues it.
    let t = ask.init();
    [t] = ask.attempt(t, "k", "x", 0);
    [t] = ask.fail(t, "k", {
      type: "resilient_err",
      key: "k",
      error: { _tag: "http_retry", status: 429 },
      at: 0,
    });
    expect(ask.subs(t)).toEqual([deadlineSub("resilient:retry:k", 0)]);
    const [, cmds] = ask.onTimer(t, {
      type: "deadline_exceeded",
      id: "resilient:retry:k",
      atMs: 0,
    });
    expect(cmds).toHaveLength(1);
  });
});

describe("createJevAsk — driven through replay against a scripted port", () => {
  it("[429, 200] settles resilient_ok once, after one backoff, with typed answers", async () => {
    const { port, calls } = scriptedPort([
      [429, { detail: "slow down" }],
      [200, okBody],
    ]);
    const ask = createJevAsk<Questions>({ questions, port, retry }, rngZero);
    const state = await drive(ask, "k", "a receipt");

    const call = callOf(state);
    expect(call.phase).toBe("succeeded");
    if (call.phase !== "succeeded") return;
    expect(call.result.source).toBe("port");
    expect(call.result.model).toBe("jev-1");
    expect(call.result.usage).toEqual({ input_tokens: 11, output_tokens: 3 });
    // The answers are typed BY the question map: this annotation is the
    // assertion — the criteria keys are the `choice` domain, and a wider type
    // would not compile.
    const choice: "groceries" | "dining" = call.result.answers.category.choice;
    expect(choice).toBe("dining");
    // Exactly two attempts: the 429 backed off, the retry succeeded.
    expect(calls).toEqual([429, 200]);
    // The retry counter for a settled key is dropped.
    expect(state.resilience.retry).toEqual({});
  });

  it("[401] settles resilient_err carrying a JevAskErr and calls the port once", async () => {
    const { port, calls } = scriptedPort([[401, { detail: "bad key" }]]);
    const ask = createJevAsk<Questions>({ questions, port, retry }, rngZero);
    const state = await drive(ask, "k", "a receipt");

    const call = callOf(state);
    expect(call.phase).toBe("failed");
    if (call.phase !== "failed") return;
    expect(call.error).toEqual({ _tag: "http_terminal", status: 401 });
    // Terminal means terminal: a retry policy is configured and still nothing
    // re-issued the request.
    expect(calls).toEqual([401]);
    // A bad key is not a health signal — the breaker stays closed.
    expect(state.resilience.circuit).toEqual({ phase: "closed", failures: 0 });
  });

  it("a 200 with a malformed body settles the protocol child's parse error", async () => {
    const { port, calls } = scriptedPort([
      [200, { model: "jev-1", answers: {}, usage: okBody.usage }],
    ]);
    const ask = createJevAsk<Questions>({ questions, port, retry }, rngZero);
    const state = await drive(ask, "k", "a receipt");

    const call = callOf(state);
    expect(call.phase).toBe("failed");
    if (call.phase !== "failed") return;
    // `parseAnswers`' own JevErr, untouched — and terminal, so one call only.
    expect(call.error).toEqual({ _tag: "missing_answer", id: "category" });
    expect(calls).toEqual([200]);
  });

  it("a body that is not an object settles malformed_body and nothing throws out", async () => {
    const { port } = scriptedPort([[200, "not json at all"]]);
    const ask = createJevAsk<Questions>({ questions, port, retry }, rngZero);
    const state = await drive(ask, "k", "a receipt");

    const call = callOf(state);
    expect(call.phase).toBe("failed");
    if (call.phase !== "failed") return;
    expect((call.error as JevAskErr)._tag).toBe("malformed_body");
  });

  it("a port that rejects is transient: it backs off and the next attempt settles", async () => {
    let n = 0;
    const port: JevPort<Questions> = async () => {
      n += 1;
      if (n === 1) throw new Error("ECONNRESET");
      return { status: 200, body: okBody };
    };
    const ask = createJevAsk<Questions>({ questions, port, retry }, rngZero);
    const state = await drive(ask, "k", "a receipt");
    expect(callOf(state).phase).toBe("succeeded");
    expect(n).toBe(2);
  });
});

describe("createJevAsk — the fallback", () => {
  const answers = okBody.answers as unknown as JevAnswers<Questions>;

  it("with no port and a fallback, it settles from the fallback and calls no port", async () => {
    const seen: string[] = [];
    const ask = createJevAsk<Questions>(
      {
        questions,
        retry,
        fallback: (request) => {
          seen.push(String(request.state));
          return answers;
        },
      },
      rngZero,
    );
    const state = await drive(ask, "k", "a receipt");

    const call = callOf(state);
    expect(call.phase).toBe("succeeded");
    if (call.phase !== "succeeded") return;
    expect(call.result).toEqual({
      answers,
      model: "jev-latest",
      usage: { input_tokens: 0, output_tokens: 0 },
      source: "fallback",
    });
    expect(seen).toEqual(["a receipt"]);
  });

  it("with neither a port nor a fallback, it settles resilient_err", async () => {
    const ask = createJevAsk<Questions>({ questions, retry }, rngZero);
    const state = await drive(ask, "k", "a receipt");

    const call = callOf(state);
    expect(call.phase).toBe("failed");
    if (call.phase !== "failed") return;
    expect(call.error).toEqual({ _tag: "no_answer_path" });
  });

  it("a fallback that refuses settles its JevErr", async () => {
    const refusal: JevErr = { _tag: "malformed_body", reason: "offline" };
    const ask = createJevAsk<Questions>(
      { questions, retry, fallback: () => refusal },
      rngZero,
    );
    const state = await drive(ask, "k", "a receipt");

    const call = callOf(state);
    expect(call.phase).toBe("failed");
    if (call.phase !== "failed") return;
    expect(call.error).toEqual(refusal);
  });

  it("an exhausted retry budget hands the call to the fallback", async () => {
    const { port, calls } = scriptedPort([
      [429, {}],
      [429, {}],
      [429, {}],
    ]);
    const ask = createJevAsk<Questions>(
      { questions, port, retry, fallback: () => answers },
      rngZero,
    );
    const state = await drive(ask, "k", "a receipt");

    // Three attempts is the whole budget; the fallback answers rather than the
    // call settling failed.
    expect(calls).toEqual([429, 429, 429]);
    const call = callOf(state);
    expect(call.phase).toBe("succeeded");
    if (call.phase !== "succeeded") return;
    expect(call.result.source).toBe("fallback");
  });

  it("an exhausted budget with NO fallback settles the last transient error", async () => {
    const { port, calls } = scriptedPort([
      [429, {}],
      [429, {}],
      [429, {}],
    ]);
    const ask = createJevAsk<Questions>({ questions, port, retry }, rngZero);
    const state = await drive(ask, "k", "a receipt");

    expect(calls).toHaveLength(3);
    const call = callOf(state);
    expect(call.phase).toBe("failed");
    if (call.phase !== "failed") return;
    expect(call.error).toEqual({ _tag: "http_retry", status: 429 });
  });
});

describe("createJevAsk — the handler returns the enriched settle Msg", () => {
  it("returns resilient_ok carrying the parsed JevOk, stamped at the boundary", async () => {
    vi.spyOn(Date, "now").mockReturnValue(42);
    const { port } = scriptedPort([[200, okBody]]);
    const ask = createJevAsk<Questions>({ questions, port, retry }, rngZero);
    const msg = await ask.handlers().resilient_run({
      type: "resilient_run",
      key: "k",
      input: { state: "x", model: "jev-latest", questions },
    });
    expect(msg.type).toBe("resilient_ok");
    expect(msg.at).toBe(42);
    vi.restoreAllMocks();
  });

  it("returns resilient_err carrying the typed JevAskErr, never a raw throw", async () => {
    const { port } = scriptedPort([[529, {}]]);
    const ask = createJevAsk<Questions>({ questions, port, retry }, rngZero);
    const msg = (await ask.handlers().resilient_run({
      type: "resilient_run",
      key: "k",
      input: { state: "x", model: "jev-latest", questions },
    })) as JevFailMsg;
    expect(msg.type).toBe("resilient_err");
    expect(msg.error).toEqual({ _tag: "http_retry", status: 529 });
  });
});

// ---------------------------------------------------------------------------
// The answers map is keyed by the CALLER's question ids, so `_tag` is a legal
// id. The fallback's ok/err discriminant must not read it as a refusal.
// ---------------------------------------------------------------------------

describe("createJevAsk — a caller may name a question `_tag`", () => {
  const tagQuestions = jevQuestions({
    _tag: {
      type: "choice",
      instructions: "Which budget line is this?",
      criteria: { groceries: "Supermarkets", dining: "Restaurants" },
    },
  });
  type TagQuestions = typeof tagQuestions;

  const tagAnswers = {
    _tag: {
      type: "choice",
      choice: "dining",
      probabilities: { groceries: 0.1, dining: 0.9 },
      confidence: 0.9,
    },
  } as unknown as JevAnswers<TagQuestions>;

  it("settles a successful fallback ok rather than as a JevErr", async () => {
    const ask = createJevAsk<TagQuestions>(
      { questions: tagQuestions, retry, fallback: () => tagAnswers },
      rngZero,
    );
    const [s1, cmds] = ask.attempt(ask.init(), "k", "a receipt", 0);
    const cmd = cmds[0];
    if (cmd === undefined) throw new Error("expected one ask Cmd");

    const settle = await ask.handlers().resilient_run(cmd);
    expect(settle.type).toBe("resilient_ok");
    if (settle.type !== "resilient_ok") return;
    expect(settle.result).toEqual({
      answers: tagAnswers,
      model: "jev-latest",
      usage: { input_tokens: 0, output_tokens: 0 },
      source: "fallback",
    });

    const [s2] = ask.succeed(s1, "k", settle);
    const call = s2.calls.k;
    expect(call?.phase).toBe("succeeded");
  });

  it("still settles a refusing fallback as its JevErr", async () => {
    const refusal: JevErr = { _tag: "malformed_body", reason: "offline" };
    const ask = createJevAsk<TagQuestions>(
      { questions: tagQuestions, retry, fallback: () => refusal },
      rngZero,
    );
    const [, cmds] = ask.attempt(ask.init(), "k", "a receipt", 0);
    const cmd = cmds[0];
    if (cmd === undefined) throw new Error("expected one ask Cmd");

    const settle = (await ask.handlers().resilient_run(cmd)) as JevFailMsg;
    expect(settle.type).toBe("resilient_err");
    expect(settle.error).toEqual(refusal);
  });
});
