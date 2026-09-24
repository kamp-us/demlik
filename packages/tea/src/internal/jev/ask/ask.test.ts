import { describe, expect, it } from "vitest";
import { defineMachine } from "../../../index";
import { drive } from "../../../testing";
import { deadlineSub } from "../../resilience/deadline";
import {
  type JevAnswers,
  type JevErr,
  type JevRequest,
  jevQuestions,
} from "../protocol";
import {
  createJevAsk,
  decodeJevReply,
  type JevAskCmd,
  type JevAskErr,
  type JevFailMsg,
  type JevHttpReply,
  type JevOk,
  type JevSucceedMsg,
  type JevTimerMsg,
  jevAskCmdDef,
  jevAskErrOf,
  jevCallThrew,
  offlineJevAnswer,
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

/** The HTTP call a handler makes — the test's stand-in for `fetch`. */
type JevHttp = (request: JevRequest<Questions>) => Promise<JevHttpReply>;

/** An HTTP stand-in that pops one scripted `[status, body]` per call and counts its calls. */
function scriptedHttp(script: readonly (readonly [number, unknown])[]) {
  const calls: number[] = [];
  const queue = [...script];
  const http: JevHttp = async () => {
    const next = queue.shift() ?? ([200, okBody] as const);
    calls.push(next[0]);
    return { status: next[0], body: next[1] };
  };
  return { http, calls };
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

const request: JevRequest<Questions> = {
  state: "x",
  model: "jev-latest",
  questions,
};

// ---------------------------------------------------------------------------
// The host machine — the knob spliced into a reducer exactly as its docblock
// wires it, with the run Cmd listed in `cmds` so the engine (here `drive`)
// mints `resilient_run_ok` / `resilient_run_err` from the handler's outcome.
// ---------------------------------------------------------------------------

interface HostState {
  readonly resilience: ResilientState<JevRequest<Questions>, JevOk<Questions>>;
}
type HostMsg =
  | { type: "ask"; key: string; content: string; at: number }
  | JevTimerMsg;

/** The knob, as the host sees it. */
type Ask = ReturnType<typeof createJevAsk<Questions>>;

function hostMachine(ask: Ask) {
  // The machine is typed with `types.cmd` and gets `cmds` spread on after:
  // the verbs emit `JevAskCmd` (resilient-call's `RunCmd`, whose `Ok` phantom
  // is `unknown`), which the `cmds`-derived `C` (`Ok` = `JevOk`) refuses.
  const machine = defineMachine({
    types: {
      model: {} as HostState,
      msg: {} as HostMsg | JevSucceedMsg<Questions> | JevFailMsg,
      cmd: {} as JevAskCmd<Questions>,
      ctx: undefined,
    },
    init: (loaded) =>
      loaded !== null ? [loaded, []] : [{ resilience: ask.init() }, []],
    update: {
      ask: (s, m) => {
        const [slice, cmds] = ask.attempt(s.resilience, m.key, m.content, m.at);
        return [{ resilience: slice }, cmds];
      },
      resilient_run_ok: (s, m) => {
        const [slice, cmds] = ask.succeed(s.resilience, m);
        return [{ resilience: slice }, cmds];
      },
      resilient_run_err: (s, m) => {
        const [slice, cmds] = ask.fail(s.resilience, m);
        return [{ resilience: slice }, cmds];
      },
      deadline_exceeded: (s, m) => {
        const [slice, cmds] = ask.onTimer(s.resilience, m);
        return [{ resilience: slice }, cmds];
      },
    },
    subs: [{ type: "timer", deps: (s: HostState) => ask.timer(s.resilience) }],
  });
  return { ...machine, cmds: [ask.run] };
}

/**
 * The handler a host writes (ADR 0021): call Jev and hand the reply to
 * `decode`, `rejected` on a throw — or, with no key at all, `offline`.
 */
function interpretWith(ask: Ask, http?: JevHttp) {
  return {
    resilient_run: async (cmd: { readonly input: JevRequest<Questions> }) => {
      if (http === undefined) return ask.offline(cmd.input);
      try {
        return ask.decode(cmd.input, await http(cmd.input));
      } catch (cause) {
        return ask.rejected(cause);
      }
    },
  };
}

/** The call phase under `key`, refusing the "no such call" read outright. */
function callOf(state: HostState, key = "k") {
  const call = state.resilience.calls[key];
  if (call === undefined) throw new Error(`no call under ${key}`);
  return call;
}

/**
 * Drive one call to its fixed point through `drive` (the real handler, the
 * real `Cmd.define` edge), and fire a retry timer by hand whenever the slice is
 * waiting for one. Returns the final host state.
 */
async function settle(
  ask: Ask,
  key: string,
  content: string,
  http?: JevHttp,
): Promise<HostState> {
  const machine = hostMachine(ask);
  const interpret = interpretWith(ask, http);
  let state: HostState = { resilience: ask.init() };
  let msg: HostMsg = { type: "ask", key, content, at: 0 };
  for (let guard = 0; guard < 20; guard += 1) {
    ({ state } = await drive(machine, state, msg, interpret, {
      clock: () => 0,
    }));
    const call = callOf(state, key);
    if (call.phase !== "waiting_retry") return state;
    msg = {
      type: "deadline_exceeded",
      id: `resilient:retry:${key}`,
      atMs: call.retryAtMs,
    };
  }
  throw new Error("settle: did not settle");
}

// ---------------------------------------------------------------------------

describe("createJevAsk — the slice and verbs are resilient-call's", () => {
  const ask = createJevAsk<Questions>({ questions, retry }, rngZero);

  it("exposes plain functions and the run Cmd, and inherits the resilient slice", () => {
    expect(Object.keys(ask).sort()).toEqual([
      "attempt",
      "deadlines",
      "decode",
      "fail",
      "init",
      "name",
      "offline",
      "onTimer",
      "rejected",
      "run",
      "succeed",
      "timer",
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
    expect(ask.run.cmdType).toBe(jevAskCmdDef<Questions>().cmdType);
    expect(s.calls.k).toEqual({
      phase: "running",
      input: { state: "a receipt", model: "jev-latest", questions },
      budget: { remainingMs: 0, chargingSinceMs: 0 },
    });
  });

  it("succeed / onTimer / deadlines / timer are resilient-call's verbs, not a second loop", () => {
    const result: JevOk<Questions> = {
      answers: okBody.answers as unknown as JevAnswers<Questions>,
      model: "jev-1",
      usage: { input_tokens: 1, output_tokens: 1 },
      source: "port",
    };
    const cmd = ask.run({ key: "k", input: request });
    let s = ask.init();
    [s] = ask.attempt(s, "k", "x", 0);
    [s] = ask.succeed(s, ask.run.ok(cmd, result, 0));
    expect(s.calls.k).toEqual({ phase: "succeeded", result });
    expect(ask.deadlines(s)).toEqual([]);
    expect(ask.timer(s)).toBeNull();

    // A transient failure arms the inherited retry timer; onTimer re-issues it.
    let t = ask.init();
    [t] = ask.attempt(t, "k", "x", 0);
    [t] = ask.fail(
      t,
      ask.run.err(
        cmd,
        { _tag: "port_rejected", jev: { _tag: "http_retry", status: 429 } },
        0,
      ),
    );
    expect(ask.deadlines(t)).toEqual([deadlineSub("resilient:retry:k", 0)]);
    expect(ask.timer(t)).toEqual({
      ms: 0,
      msg: { type: "deadline_exceeded", id: "resilient:retry:k", atMs: 0 },
    });
    const [, cmds] = ask.onTimer(t, {
      type: "deadline_exceeded",
      id: "resilient:retry:k",
      atMs: 0,
    });
    expect(cmds).toHaveLength(1);
  });

  it("fail stores the typed JevAskErr, never the port_rejected carrier", () => {
    let t = ask.init();
    [t] = ask.attempt(t, "k", "x", 0);
    [t] = ask.fail(
      t,
      ask.run.err(
        ask.run({ key: "k", input: request }),
        { _tag: "port_rejected", jev: { _tag: "http_terminal", status: 401 } },
        0,
      ),
    );
    expect(t.calls.k).toEqual({
      phase: "failed",
      error: { _tag: "http_terminal", status: 401 },
    });
  });
});

describe("createJevAsk — driven through the engine edge against a scripted HTTP call", () => {
  it("[429, 200] settles resilient_run_ok once, after one backoff, with typed answers", async () => {
    const { http, calls } = scriptedHttp([
      [429, { detail: "slow down" }],
      [200, okBody],
    ]);
    const ask = createJevAsk<Questions>({ questions, retry }, rngZero);
    const state = await settle(ask, "k", "a receipt", http);

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

  it("[401] settles resilient_run_err carrying a JevAskErr and calls once", async () => {
    const { http, calls } = scriptedHttp([[401, { detail: "bad key" }]]);
    const ask = createJevAsk<Questions>({ questions, retry }, rngZero);
    const state = await settle(ask, "k", "a receipt", http);

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
    const { http, calls } = scriptedHttp([
      [200, { model: "jev-1", answers: {}, usage: okBody.usage }],
    ]);
    const ask = createJevAsk<Questions>({ questions, retry }, rngZero);
    const state = await settle(ask, "k", "a receipt", http);

    const call = callOf(state);
    expect(call.phase).toBe("failed");
    if (call.phase !== "failed") return;
    // `parseAnswers`' own JevErr, untouched — and terminal, so one call only.
    expect(call.error).toEqual({ _tag: "missing_answer", id: "category" });
    expect(calls).toEqual([200]);
  });

  it("a body that is not an object settles malformed_body and nothing throws out", async () => {
    const { http } = scriptedHttp([[200, "not json at all"]]);
    const ask = createJevAsk<Questions>({ questions, retry }, rngZero);
    const state = await settle(ask, "k", "a receipt", http);

    const call = callOf(state);
    expect(call.phase).toBe("failed");
    if (call.phase !== "failed") return;
    expect((call.error as JevAskErr)._tag).toBe("malformed_body");
  });

  it("a call that throws is transient: it backs off and the next attempt settles", async () => {
    let n = 0;
    const http: JevHttp = async () => {
      n += 1;
      if (n === 1) throw new Error("ECONNRESET");
      return { status: 200, body: okBody };
    };
    const ask = createJevAsk<Questions>({ questions, retry }, rngZero);
    const state = await settle(ask, "k", "a receipt", http);
    expect(callOf(state).phase).toBe("succeeded");
    expect(n).toBe(2);
  });
});

describe("createJevAsk — the fallback", () => {
  const answers = okBody.answers as unknown as JevAnswers<Questions>;

  it("with no key and a fallback, it settles from the fallback and makes no HTTP call", async () => {
    const seen: string[] = [];
    const ask = createJevAsk<Questions>(
      {
        questions,
        retry,
        fallback: (req) => {
          seen.push(String(req.state));
          return answers;
        },
      },
      rngZero,
    );
    const state = await settle(ask, "k", "a receipt");

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

  it("with neither a key nor a fallback, it settles resilient_run_err", async () => {
    const ask = createJevAsk<Questions>({ questions, retry }, rngZero);
    const state = await settle(ask, "k", "a receipt");

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
    const state = await settle(ask, "k", "a receipt");

    const call = callOf(state);
    expect(call.phase).toBe("failed");
    if (call.phase !== "failed") return;
    expect(call.error).toEqual(refusal);
  });

  it("an exhausted retry budget hands the call to the fallback", async () => {
    const { http, calls } = scriptedHttp([
      [429, {}],
      [429, {}],
      [429, {}],
    ]);
    const ask = createJevAsk<Questions>(
      { questions, retry, fallback: () => answers },
      rngZero,
    );
    const state = await settle(ask, "k", "a receipt", http);

    // Three attempts is the whole budget; the fallback answers rather than the
    // call settling failed.
    expect(calls).toEqual([429, 429, 429]);
    const call = callOf(state);
    expect(call.phase).toBe("succeeded");
    if (call.phase !== "succeeded") return;
    expect(call.result.source).toBe("fallback");
  });

  it("an exhausted budget with NO fallback settles the last transient error", async () => {
    const { http, calls } = scriptedHttp([
      [429, {}],
      [429, {}],
      [429, {}],
    ]);
    const ask = createJevAsk<Questions>({ questions, retry }, rngZero);
    const state = await settle(ask, "k", "a receipt", http);

    expect(calls).toHaveLength(3);
    const call = callOf(state);
    expect(call.phase).toBe("failed");
    if (call.phase !== "failed") return;
    expect(call.error).toEqual({ _tag: "http_retry", status: 429 });
  });
});

describe("createJevAsk — the outcome builders a handler returns", () => {
  it("decode turns a 200 into the parsed JevOk, and the edge stamps `at`", async () => {
    const ask = createJevAsk<Questions>({ questions, retry }, rngZero);
    const outcome = decodeJevReply(request, { status: 200, body: okBody });
    expect(outcome._tag).toBe("Ok");
    if (outcome._tag !== "Ok") return;
    expect(outcome.value.source).toBe("port");

    const { trace } = await drive(
      hostMachine(ask),
      { resilience: ask.init() },
      { type: "ask", key: "k", content: "x", at: 0 },
      interpretWith(ask, async () => ({ status: 200, body: okBody })),
      { clock: () => 42 },
    );
    const settled = trace.find(
      (e) => e.kind === "msg" && e.msg.type === "resilient_run_ok",
    );
    expect(
      settled?.kind === "msg" && "at" in settled.msg && settled.msg.at,
    ).toBe(42);
  });

  it("decode turns a 529 into the typed transient JevAskErr, never a raw throw", () => {
    const outcome = decodeJevReply(request, { status: 529, body: {} });
    expect(outcome).toEqual({
      _tag: "Err",
      error: {
        _tag: "port_rejected",
        jev: { _tag: "http_retry", status: 529 },
      },
    });
    if (outcome._tag !== "Err") return;
    expect(jevAskErrOf(outcome.error)).toEqual({
      _tag: "http_retry",
      status: 529,
    });
  });

  it("jevCallThrew is the transient port_threw; a foreign failure reads the same", () => {
    const outcome = jevCallThrew(new Error("ECONNRESET"));
    expect(outcome._tag).toBe("Err");
    if (outcome._tag !== "Err") return;
    expect(jevAskErrOf(outcome.error)._tag).toBe("port_threw");
    expect(jevAskErrOf({ _tag: "deadline_exceeded" })._tag).toBe("port_threw");
  });

  it("offlineJevAnswer with no fallback is no_answer_path", () => {
    expect(offlineJevAnswer(request, undefined)).toEqual({
      _tag: "Err",
      error: { _tag: "port_rejected", jev: { _tag: "no_answer_path" } },
    });
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

  it("settles a successful fallback ok rather than as a JevErr", () => {
    const ask = createJevAsk<TagQuestions>(
      { questions: tagQuestions, retry, fallback: () => tagAnswers },
      rngZero,
    );
    const [s1, cmds] = ask.attempt(ask.init(), "k", "a receipt", 0);
    const emitted = cmds[0];
    if (emitted === undefined) throw new Error("expected one ask Cmd");

    const outcome = ask.offline(emitted.input);
    expect(outcome._tag).toBe("Ok");
    if (outcome._tag !== "Ok") return;
    expect(outcome.value).toEqual({
      answers: tagAnswers,
      model: "jev-latest",
      usage: { input_tokens: 0, output_tokens: 0 },
      source: "fallback",
    });

    const cmd = ask.run({ key: emitted.key, input: emitted.input });
    const [s2] = ask.succeed(s1, ask.run.ok(cmd, outcome.value, 0));
    expect(s2.calls.k?.phase).toBe("succeeded");
  });

  it("still settles a refusing fallback as its JevErr", () => {
    const refusal: JevErr = { _tag: "malformed_body", reason: "offline" };
    const ask = createJevAsk<TagQuestions>(
      { questions: tagQuestions, retry, fallback: () => refusal },
      rngZero,
    );
    const [s1, cmds] = ask.attempt(ask.init(), "k", "a receipt", 0);
    const emitted = cmds[0];
    if (emitted === undefined) throw new Error("expected one ask Cmd");

    const outcome = ask.offline(emitted.input);
    expect(outcome).toEqual({
      _tag: "Err",
      error: { _tag: "port_rejected", jev: refusal },
    });
    if (outcome._tag !== "Err") return;
    const cmd = ask.run({ key: emitted.key, input: emitted.input });
    const [s2] = ask.fail(s1, ask.run.err(cmd, outcome.error, 0));
    expect(s2.calls.k).toEqual({ phase: "failed", error: refusal });
  });
});
