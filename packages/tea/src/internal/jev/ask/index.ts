/**
 * @packageDocumentation
 * internal/jev/ask — one Cmd that asks Jev a question map, over
 * `../../resilience/resilient-call`, with a pure fallback behind it. Internal
 * since #217 — not published on any subpath; `../protocol` is the wire contract
 * it speaks.
 *
 * This is `../../llm-call` for Jev: a config object, the resilient-call slice
 * it INHERITS, the `Cmd.define`d run Cmd, and the pure functions that turn an
 * HTTP reply into that Cmd's outcome. It ships no I/O (ADR 0021, 0022): the
 * HTTP call is the handler YOU write, in your engine's style, and it hands the
 * reply to `decode`. `init`, `attempt`, `succeed`, `onTimer`, `deadlines` and
 * `timer` are resilient-call's verbs forwarded; there is no retry loop and no
 * clock read in any verb here.
 *
 * ## The handler you write, and the one policy
 *
 *   - The `resilient_run` handler calls Jev and returns
 *     `ask.decode(cmd.input, { status, body })` — or `ask.rejected(cause)` when
 *     the call itself threw. The key lives in your handler's closure, never in
 *     config: the door never reads an env var or holds a key.
 *   - `fallback?: (request) => JevAnswers<Q> | JevErr` — a PURE deterministic
 *     decider. It answers on the two paths where the network cannot: a handler
 *     with no key returns `ask.offline(cmd.input)`, and the resilient retry
 *     budget is spent. Pure is the requirement, not a preference — the
 *     exhaustion path calls it inside the `fail` verb, so a fallback that read
 *     a clock or a socket would break replay.
 *   - `retry: RetryPolicy` — handed straight to resilient-call. Omit it and the
 *     first transient failure is terminal, exactly as resilient-call documents.
 *
 * ## Which failures back off and which do not
 *
 * `classifyStatus` (the protocol child, the single reading of the error table)
 * splits the answer three ways, and that split IS the retry decision:
 *
 *   - `ok` → parse. A body that disagrees with the questions asked settles
 *     `resilient_run_err` carrying the protocol's own {@link JevErr} —
 *     terminal, because the same request will produce the same body.
 *   - `retry` (429 / 529) → a TRANSIENT {@link JevAskErr}. `fail` feeds it to
 *     resilient-call's backoff, so the call waits and re-issues.
 *   - `terminal` (401 / 422 / anything else non-2xx) → a terminal
 *     {@link JevAskErr}. `fail` settles it through `settleFailed`: the call
 *     ends now, the breaker is not tripped and the handler is NOT run again.
 *
 * Every failure crosses the handler as the run Cmd's one declared tag,
 * `port_rejected`, with the typed {@link JevAskErr} riding on `jev`
 * ({@link JevRejected}). `fail` reads it back with {@link jevAskErrOf}.
 *
 * ## Typical wiring
 *
 *   const ask = createJevAsk({
 *     questions,                        // the map; its keys type the answers
 *     fallback: (req) => offlineGuess(req),
 *     retry: defaultRetryPolicy,
 *   });
 *
 *   // in the machine:
 *   cmds: [ask.run],
 *   init: () => [{ resilience: ask.init(), answers: null, failure: null }, []],
 *   update: {
 *     ask_jev: (s, m) => liftJevAsk(s, ask.attempt(s.resilience, m.key, m.state, m.at)),
 *     resilient_run_ok: (s, m) => …ask.succeed(s.resilience, m)…,
 *     resilient_run_err: (s, m) => …ask.fail(s.resilience, m)…,
 *     deadline_exceeded: (s, m) => liftJevAsk(s, ask.onTimer(s.resilience, m)),
 *   },
 *   subs: [{ type: "timer", deps: (s) => ask.timer(s.resilience) }],
 *
 *   // and where it runs — the HTTP call is your handler:
 *   run(machine, {
 *     interpret: {
 *       resilient_run: async (cmd) => {
 *         try { return ask.decode(cmd.input, await callJev(apiKey, cmd.input)); }
 *         catch (cause) { return ask.rejected(cause); }
 *       },
 *     },
 *   });
 */

import { liftSlice } from "../../../compose";
import { describeError } from "../../../describe-error";
import { type Cmd, Outcome } from "../../../index";
import type { RetryPolicy } from "../../../retry-backoff";
import type { DeadlineExceeded, DeadlineSub } from "../../resilience/deadline";
import {
  createResilientCall,
  type FailMsg,
  type ResilientConfig,
  type ResilientState,
  type RunCmd,
  runCmdDef,
  type SucceedMsg,
} from "../../resilience/resilient-call";
import {
  classifyStatus,
  isJevErr,
  type JevAnswers,
  type JevErr,
  type JevQuestionMap,
  type JevRequest,
  type JevState,
  type JevUsage,
  parseAnswers,
} from "../protocol";

// ===========================================================================
// The reply your handler hands back, and the fallback.
// ===========================================================================

/**
 * What an HTTP call to Jev came back with: the status and the undecoded body.
 *
 * Your handler returns this to {@link decodeJevReply} rather than throwing on a
 * non-2xx, because WHICH non-2xx it is decides whether the call backs off, and
 * a thrown error has already lost that.
 */
export interface JevHttpReply {
  readonly status: number;
  readonly body: unknown;
}

/**
 * The pure decider that answers when the network cannot.
 *
 * Called on exactly two paths: a handler with no key returns
 * {@link offlineJevAnswer}, and the resilient retry budget is spent. It must
 * be a pure function of the request — the exhaustion path runs it inside the
 * `fail` VERB, which replay re-runs, so a clock read or an I/O call here would
 * make the machine unreplayable. Returning a {@link JevErr} is how a fallback
 * says "I have no answer for this one"; the call then settles as that error.
 */
export type JevFallback<Q extends JevQuestionMap> = (
  request: JevRequest<Q>,
) => JevAnswers<Q> | JevErr;

// ===========================================================================
// Failures — the protocol's, plus the three this door adds.
// ===========================================================================

/**
 * Every way an ask can fail, as DATA.
 *
 * A superset of the protocol child's {@link JevErr}: a parse failure is
 * reported with the protocol's own tag untouched, and the tags below are the
 * ones only a caller can observe. `{_tag}`-discriminated and
 * JSON-round-trippable like the rest (ADR 0011), because it is carried on the
 * settle Msg and stored in the slice's `failed` phase.
 *
 * `http_retry` and `port_threw` are the TRANSIENT pair — {@link isTransientJevAskErr}
 * is the single reading, and `fail` backs off on exactly those two.
 */
export type JevAskErr =
  | JevErr
  /** 429 / 529 — the statuses `classifyStatus` says to back off on. */
  | { readonly _tag: "http_retry"; readonly status: number }
  /** 401 / 422 / any other non-2xx — this request fails identically forever. */
  | { readonly _tag: "http_terminal"; readonly status: number }
  /** The call itself threw (a socket error, a DNS failure) — transient. */
  | { readonly _tag: "port_threw"; readonly reason: string }
  /** No key and no `fallback`: the knob was configured with no way to answer. */
  | { readonly _tag: "no_answer_path" };

/**
 * Does this failure deserve another attempt?
 *
 * The one place the transient/terminal split is read. A rate limit and a dropped
 * socket are the two failures a second attempt can clear; a 401, a 422 and every
 * parse failure will reproduce exactly, so retrying one spends a real HTTP call
 * to learn nothing.
 */
export function isTransientJevAskErr(error: JevAskErr): boolean {
  return error._tag === "http_retry" || error._tag === "port_threw";
}

/**
 * How a {@link JevAskErr} crosses the handler: the run Cmd's declared
 * `port_rejected` tag, with the typed error on `jev`. The engine mints it into
 * `resilient_run_err` untouched, and {@link jevAskErrOf} reads it back.
 */
export type JevRejected = {
  readonly _tag: "port_rejected";
  readonly jev: JevAskErr;
};

/** Build the {@link JevRejected} outcome for one {@link JevAskErr}. PURE. */
function reject(jev: JevAskErr): Outcome<never, JevRejected> {
  return Outcome.err({ _tag: "port_rejected", jev });
}

/**
 * Read a settled failure back as a {@link JevAskErr}. PURE.
 *
 * A {@link JevRejected} yields its `jev`. Anything else a handler returned —
 * a bare `port_rejected`, a `deadline_exceeded` — is a failure this door did
 * not classify, and it reads as the transient `port_threw`, exactly as a
 * foreign throw always has.
 */
export function jevAskErrOf(error: unknown): JevAskErr {
  if (typeof error === "object" && error !== null) {
    const jev = (error as { readonly jev?: unknown }).jev;
    if (
      typeof jev === "object" &&
      jev !== null &&
      typeof (jev as { readonly _tag?: unknown })._tag === "string"
    ) {
      return jev as JevAskErr;
    }
  }
  return { _tag: "port_threw", reason: describeError(error) };
}

// ===========================================================================
// Config, request and result.
// ===========================================================================

/** The model the door asks for when config names none. */
export const DEFAULT_JEV_MODEL = "jev-latest";

/** No tokens were spent — what a fallback answer's usage is. */
const NO_USAGE: JevUsage = { input_tokens: 0, output_tokens: 0 };

/**
 * The jev-ask knob. `questions` is the load-bearing one: it is both the map
 * sent on every request and the type that makes the answers narrow at the call
 * site, so it belongs to the knob rather than to a call.
 */
export interface JevAskConfig<Q extends JevQuestionMap> {
  /** The question map every request carries; its keys type the answers. */
  readonly questions: Q;
  /** The pure decider for the no-key and budget-spent paths. Absent → those settle as an error. */
  readonly fallback?: JevFallback<Q>;
  /** Backoff policy, composed into `../../resilience/resilient-call`. Omit → no backoff. */
  readonly retry?: RetryPolicy;
  /** The model id asked for. Defaults to {@link DEFAULT_JEV_MODEL}. */
  readonly model?: string;
}

/**
 * The settled answer carried on `resilient_run_ok`.
 *
 * `source` is not decoration: a fallback answer and a model answer are both
 * valid answers with identical shape, and a host that routes on confidence — or
 * bills on usage — has to be able to tell them apart. A fallback's `usage` is
 * zero because nothing was spent.
 */
export interface JevOk<Q extends JevQuestionMap> {
  /** The typed answers, one per question id. */
  readonly answers: JevAnswers<Q>;
  /** The model that answered, as the response reported it (or the requested one, for a fallback). */
  readonly model: string;
  /** Tokens spent. Zero on the fallback path. */
  readonly usage: JevUsage;
  /** Which path produced this answer. */
  readonly source: "port" | "fallback";
}

// ===========================================================================
// The pure outcome builders your handler returns.
// ===========================================================================

/**
 * A fallback's answer or its refusal.
 *
 * The discriminant is the protocol child's own {@link isJevErr} — the `_tag`
 * VALUE read against the closed `JevErr` tag set. Testing for the KEY instead
 * reads a caller's question ids as a discriminant they never agreed to: a
 * question legally named `_tag` makes `"_tag" in decided` true on a perfectly
 * good answers map, and the successful fallback then settles as a refusal
 * carrying the answers map as its error. An answer is always an object and
 * never one of those five tag literals, so the value test cannot collide.
 */
function isErrDecision<Q extends JevQuestionMap>(
  decided: JevAnswers<Q> | JevErr,
): decided is JevErr {
  return isJevErr(decided);
}

/**
 * Turn an HTTP reply into the run Cmd's outcome. PURE: classify the status,
 * then parse the body against the questions the request carried.
 *
 * `ok` → the typed {@link JevOk}; a 429 / 529 → the transient `http_retry`;
 * any other non-2xx → the terminal `http_terminal`; a body that disagrees with
 * the questions → the protocol's own {@link JevErr}. Every failure is a
 * {@link JevRejected}.
 */
export function decodeJevReply<Q extends JevQuestionMap>(
  request: JevRequest<Q>,
  reply: JevHttpReply,
): Outcome<JevOk<Q>, JevRejected> {
  const kind = classifyStatus(reply.status);
  if (kind === "retry")
    return reject({ _tag: "http_retry", status: reply.status });
  if (kind === "terminal") {
    return reject({ _tag: "http_terminal", status: reply.status });
  }
  const parsed = parseAnswers(request.questions, reply.body);
  if (!parsed.ok) return reject(parsed.error);
  return Outcome.ok({
    answers: parsed.answers,
    model: parsed.model,
    usage: parsed.usage,
    source: "port",
  });
}

/**
 * The outcome for a call that threw before Jev answered — a socket error, a
 * DNS failure. PURE. It is the transient `port_threw`, so it backs off.
 */
export function jevCallThrew(cause: unknown): Outcome<never, JevRejected> {
  return reject({ _tag: "port_threw", reason: describeError(cause) });
}

/**
 * The outcome with no network at all: the fallback's answer, or its refusal,
 * or `no_answer_path` when there is no fallback. PURE — what a handler with
 * no key returns.
 */
export function offlineJevAnswer<Q extends JevQuestionMap>(
  request: JevRequest<Q>,
  fallback: JevFallback<Q> | undefined,
): Outcome<JevOk<Q>, JevRejected> {
  if (fallback === undefined) return reject({ _tag: "no_answer_path" });
  const decided = fallback(request);
  if (isErrDecision(decided)) return reject(decided);
  return Outcome.ok({
    answers: decided,
    model: request.model,
    usage: NO_USAGE,
    source: "fallback",
  });
}

// ===========================================================================
// The Cmd + Msgs the knob speaks.
// ===========================================================================

/**
 * The one effect this knob emits: run the ask for `key` with the plain-data
 * {@link JevRequest} (ADR 0014 — a Cmd is DECLARED, so its input, ok and err
 * channels are types on the constructor rather than a convention). It is
 * resilient-call's `runCmdDef` specialized to this door's input and result, the
 * same way `../../idempotency/idempotent-intake` mints its defs per knob: `Q` is
 * a type parameter, so the def is a factory and not a module constant.
 */
export function jevAskCmdDef<Q extends JevQuestionMap>() {
  return runCmdDef<JevRequest<Q>, JevOk<Q>>();
}

/** The Cmd the verbs emit — `resilient_run` carrying the request. */
export type JevAskCmd<Q extends JevQuestionMap> = RunCmd<
  JevRequest<Q>,
  "resilient",
  JevOk<Q>
>;

/** The success settle Msg — resilient-call's, with `value` narrowed to {@link JevOk}. */
export type JevSucceedMsg<Q extends JevQuestionMap> = SucceedMsg<JevOk<Q>>;

/**
 * The failure settle Msg the engine mints — resilient-call's. Its `error` is a
 * {@link JevRejected} when your handler used this door's builders; `fail`
 * reads it with {@link jevAskErrOf}.
 */
export type JevFailMsg = FailMsg;

/** The retry / deadline timer Msg — `DeadlineExceeded`, inherited. */
export type JevTimerMsg = DeadlineExceeded;

// ===========================================================================
// The knob factory.
// ===========================================================================

/**
 * Build a jev-ask knob from `config`. `rng` is injected for the inherited retry
 * jitter (pass a fixed `() => 0` in tests to pin backoff; defaults to
 * `Math.random`, read only at resilient-call's verb boundary).
 *
 * The slice and most verbs are resilient-call's, forwarded. `fail` is the one
 * composed verb — it reads the {@link JevAskErr} back off the settled Msg and
 * routes on it (see its docblock); it reimplements no backoff. `decode`,
 * `rejected` and `offline` are the pure outcome builders your handler returns.
 */
export function createJevAsk<Q extends JevQuestionMap>(
  config: JevAskConfig<Q>,
  rng: () => number = Math.random,
) {
  const resilientConfig: ResilientConfig = {
    ...(config.retry === undefined ? {} : { retry: config.retry }),
  };
  const rc = createResilientCall<JevRequest<Q>, JevOk<Q>>(resilientConfig, rng);
  const model = config.model ?? DEFAULT_JEV_MODEL;

  /** The slice this knob owns — resilient-call's slice verbatim. */
  type State = ResilientState<JevRequest<Q>, JevOk<Q>>;

  /** The request a call under `key` is live with, or `undefined` if it is not live. */
  function liveRequest(s: State, key: string): JevRequest<Q> | undefined {
    const call = s.calls[key];
    if (call?.phase === "running" || call?.phase === "waiting_retry") {
      return call.input;
    }
    return undefined;
  }

  /** The starting slice — resilient-call's. */
  function init(): State {
    return rc.init();
  }

  /**
   * Ask the configured questions about `content` under `key`. PURE — it builds
   * the plain-data request (no closures: `state`, `model` and `questions` are
   * all values) and delegates straight to resilient-call's gate.
   */
  function attempt(
    s: State,
    key: string,
    content: JevState,
    at: number,
  ): readonly [State, readonly JevAskCmd<Q>[]] {
    const request: JevRequest<Q> = {
      state: content,
      model,
      questions: config.questions,
    };
    return rc.attempt(s, key, request, at);
  }

  /** Record a settled answer. PURE — resilient-call's `settle`. */
  function succeed(
    s: State,
    msg: JevSucceedMsg<Q>,
  ): readonly [State, readonly JevAskCmd<Q>[]] {
    const { call, cmds } = rc.settle(s, msg);
    return [call, cmds];
  }

  /**
   * Settle `key` from the fallback, as if the fallback's answer were the
   * response. PURE — the fallback is a pure decider, and `settle` /
   * `settleFailed` are resilient-call's own settle verbs. `s` is the state
   * BEFORE the failing attempt was recorded, so the call is still live and
   * `settle` closes it normally.
   */
  function settleFromFallback(
    s: State,
    key: string,
    request: JevRequest<Q>,
    fallback: JevFallback<Q>,
    at: number,
  ): readonly [State, readonly JevAskCmd<Q>[]] {
    const decided = offlineJevAnswer(request, fallback);
    if (decided._tag === "Err") {
      return rc.settleFailed(s, key, decided.error.jev, at);
    }
    const { call, cmds } = rc.settle(s, {
      cmd: { key },
      value: decided.value,
      at,
    });
    return [call, cmds];
  }

  /**
   * Record a failure. PURE. The backoff itself is resilient-call's — nothing
   * here recomputes a delay, counts an attempt or reads a clock. What this verb
   * adds is the routing the typed error makes possible, and it is two
   * decisions:
   *
   *   1. A TERMINAL error settles through `settleFailed`, which ends the call
   *      without touching the breaker or the retry counter. Handing a 401 or a
   *      parse failure to `settle` instead would re-issue the identical request
   *      and trip a breaker over a backend that is perfectly healthy.
   *   2. When the transient path EXHAUSTS the retry budget and a `fallback` is
   *      configured, the fallback answers instead of the call settling failed.
   *      This is the one place that can be observed — exhaustion is a fact of
   *      the slice, not of the handler, so the handler cannot know it is on the
   *      last attempt.
   *
   * The slice's `failed` phase stores the typed {@link JevAskErr}, never the
   * {@link JevRejected} carrier.
   */
  function fail(
    s: State,
    msg: JevFailMsg,
  ): readonly [State, readonly JevAskCmd<Q>[]] {
    const { key } = msg.cmd;
    const error = jevAskErrOf(msg.error);
    if (!isTransientJevAskErr(error)) {
      return rc.settleFailed(s, key, error, msg.at);
    }
    const request = liveRequest(s, key);
    const { call, cmds, outcome } = rc.settle(s, { ...msg, error });
    if (
      outcome.kind !== "failed" ||
      config.fallback === undefined ||
      request === undefined
    ) {
      return [call, cmds];
    }
    return settleFromFallback(s, key, request, config.fallback, msg.at);
  }

  /** A retry / deadline timer fired. PURE — resilient-call's `onTimer`. */
  function onTimer(
    s: State,
    msg: JevTimerMsg,
  ): readonly [State, readonly JevAskCmd<Q>[]] {
    return rc.onTimer(s, msg);
  }

  /** The call's deadlines — resilient-call's retry and deadline timers. */
  function deadlines(s: State): readonly DeadlineSub[] {
    return rc.deadlines(s);
  }

  return {
    name: rc.name,
    /** The `Cmd.define`d run Cmd — list it in the machine's `cmds`. */
    run: rc.run,
    init,
    attempt,
    succeed,
    fail,
    onTimer,
    deadlines,
    /** The built-in `timer` Sub's deps — resilient-call's `timer`. */
    timer: rc.timer,
    /** Your handler's outcome for an HTTP reply — {@link decodeJevReply}. */
    decode: (request: JevRequest<Q>, reply: JevHttpReply) =>
      decodeJevReply(request, reply),
    /** Your handler's outcome when the call threw — {@link jevCallThrew}. */
    rejected: jevCallThrew,
    /** Your handler's outcome with no network — {@link offlineJevAnswer}. */
    offline: (request: JevRequest<Q>) =>
      offlineJevAnswer(request, config.fallback),
  };
}

/**
 * The Cmd type a host machine declares in `types.cmd` when it splices a
 * {@link createJevAsk} knob in — {@link JevAskCmd} under the name a `types`
 * block reads well with. It is stated here so a host writes `cmd: {} as
 * JevCmd<Questions>` rather than deriving it from the knob's shape.
 */
export type JevCmd<Q extends JevQuestionMap> = JevAskCmd<Q>;

/**
 * Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the slice
 * lives at `state.resilience` — resilient-call's convenience, re-typed for this
 * door's slice so a consumer wires one import. Pure.
 *
 * The record rebuild is `liftSlice` from the root door (#231), the same helper
 * `liftResilience` is expressed over — this stays as the named, pre-keyed
 * convenience for this door, unchanged in name, signature and subpath.
 */
export function liftJevAsk<
  S extends { resilience: ResilientState<JevRequest<Q>, JevOk<Q>> },
  Q extends JevQuestionMap,
  C extends Cmd,
>(
  state: S,
  result: readonly [ResilientState<JevRequest<Q>, JevOk<Q>>, readonly C[]],
): readonly [S, readonly C[]] {
  return liftSlice("resilience", state, result);
}

export type { ResilientState };
