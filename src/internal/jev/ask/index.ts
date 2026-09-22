/**
 * @packageDocumentation
 * internal/jev/ask — one Cmd that asks Jev a question map, over
 * `../../resilience/resilient-call`, with the HTTP caller injected as a port
 * and a pure fallback behind it. Internal since #217 — not published on any
 * subpath; `../protocol` is the wire contract it speaks.
 *
 * This is `../../llm-call` for Jev: a config object, the resilient-call slice
 * it INHERITS, and one interpret handler that calls the port, classifies the
 * status, parses the body against the questions that produced it, and returns
 * the enriched resilient settle Msg so it re-enters the host reducer.
 * `init`, `attempt`, `succeed`, `onTimer` and `subs` are resilient-call's verbs
 * forwarded; there is no retry loop, no timer and no `Date.now()` in any verb
 * here.
 *
 * ## The two ports and the one policy
 *
 *   - `port: JevPort<Q>` — the injected HTTP caller,
 *     `(request, signal?) => Promise<{ status, body }>`. A `fetch`-backed
 *     adapter and a scripted test fake satisfy it identically, and the door
 *     never reads an env var or holds a key: whoever builds the adapter owns
 *     the `Authorization` header. `undefined` is the no-key case, and it is a
 *     legal configuration — see the fallback.
 *   - `fallback?: (request) => JevAnswers<Q> | JevErr` — a PURE deterministic
 *     decider. It answers on the two paths where the network cannot: `port` is
 *     absent, or the resilient retry budget is spent. Pure is the requirement,
 *     not a preference — the exhaustion path calls it inside the `fail` verb,
 *     so a fallback that read a clock or a socket would break replay.
 *   - `retry: RetryPolicy` — handed straight to resilient-call. Omit it and the
 *     first transient failure is terminal, exactly as resilient-call documents.
 *
 * ## Which failures back off and which do not
 *
 * `classifyStatus` (the protocol child, the single reading of the error table)
 * splits the answer three ways, and that split IS the retry decision:
 *
 *   - `ok` → parse. A body that disagrees with the questions asked settles
 *     `resilient_err` carrying the protocol's own {@link JevErr} — terminal,
 *     because the same request will produce the same body.
 *   - `retry` (429 / 529) → a TRANSIENT {@link JevAskErr}. `fail` feeds it to
 *     resilient-call's backoff, so the call waits and re-issues.
 *   - `terminal` (401 / 422 / anything else non-2xx) → a terminal
 *     {@link JevAskErr}. `fail` settles it through `settleFailed`: the call
 *     ends now, the breaker is not tripped and the port is NOT called again.
 *
 * ## Typical wiring
 *
 *   const ask = createJevAsk({
 *     questions,                        // the map; its keys type the answers
 *     port: fetchJevPort(apiKey),       // or omit it and configure `fallback`
 *     fallback: (req) => offlineGuess(req),
 *     retry: defaultRetryPolicy,
 *   });
 *
 *   // `mountResilientCall` pre-assembles the wiring. The settle cells run the
 *   // inherited verb and hand the ALREADY-settled model to `onOk` / `onErr`,
 *   // so the fold-before-settle order that wedges the slice at `running` is
 *   // not something a mounted cell can express; `subscribe` and `interpret`
 *   // ride along, so neither can be forgotten.
 *   const mounted = mountResilientCall(ask, {
 *     slice: "resilience",
 *     attempt: {
 *       on: "ask_jev",
 *       run: (slice, m: AskJev) => ask.attempt(slice, m.key, m.state, m.at),
 *     },
 *     onOk: (s, m) => [{ ...s, answers: m.result.answers }, []],
 *     onErr: (s, m) => [{ ...s, failure: m.error }, []],
 *   });
 *
 *   // in the machine:
 *   init: () => [{ ...mounted.init(), answers: null, failure: null }, []],
 *   update: { ...mounted.update },
 *   subscriptions: mounted.subscriptions,
 *   subscribe: mounted.subscribe,
 *   interpret: mounted.interpret,
 *
 * The slice stays a plain readable field at `resilience`, and every verb above
 * is still exported: a consumer that wants a settle cell the mount cannot
 * express writes that one cell with `ask.succeed` / `ask.fail` / `liftJevAsk`
 * and spreads the rest.
 */

import { describeError } from "../../../describe-error";
import type { Cmd } from "../../../index";
import { MsgType } from "../../../protocol";
import type { RetryPolicy } from "../../../retry-backoff";
import {
  createResilientCall,
  type DeadlineExceeded,
  type DeadlineSub,
  deadlineSub,
  type FailMsg,
  liftResilience,
  mountResilientCall,
  type ResilientConfig,
  type ResilientState,
  type RunCmd,
  runCmdDef,
  type SucceedMsg,
  subscribeDeadline,
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
// The DI ports.
// ===========================================================================

/**
 * The injected HTTP caller — the one seam that touches the network.
 *
 * It returns the status and the undecoded body rather than throwing on a
 * non-2xx, because WHICH non-2xx it is decides whether the call backs off, and
 * a thrown adapter error has already lost that. `signal` is optional so a
 * `fetch` adapter can be cancelled; resilient-call issues no signal today, and
 * the slot exists so an adapter's own shape does not have to change when it
 * does.
 *
 * A `fetch` adapter and a scripted test fake satisfy this identically, which is
 * the whole reason the key lives in the adapter's closure and never in config.
 */
export type JevPort<Q extends JevQuestionMap = JevQuestionMap> = (
  request: JevRequest<Q>,
  signal?: AbortSignal,
) => Promise<{ readonly status: number; readonly body: unknown }>;

/**
 * The pure decider that answers when the network cannot.
 *
 * Called on exactly two paths: `port` is absent (the no-key case), and the
 * resilient retry budget is spent. It must be a pure function of the request —
 * the exhaustion path runs it inside the `fail` VERB, which replay re-runs, so
 * a clock read or an I/O call here would make the machine unreplayable.
 * Returning a {@link JevErr} is how a fallback says "I have no answer for
 * this one"; the call then settles as that error.
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
 * reported with the protocol's own tag untouched, and the three tags below are
 * the ones only a caller can observe. `{_tag}`-discriminated and
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
  /** The port itself rejected (a socket error, a DNS failure) — transient. */
  | { readonly _tag: "port_threw"; readonly reason: string }
  /** No `port` and no `fallback`: the knob was configured with no way to answer. */
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
 * The carrier that gets a {@link JevAskErr} out of the port and through
 * resilient-call's throw seam intact.
 *
 * resilient-call routes a rejected port to a failure Msg carrying the raw
 * thrown value, so throwing is the only way the handler can say "this attempt
 * failed" — and a bare `Error` would arrive with its classification already
 * lost. The typed payload rides on `jev`; the slice never stores this object
 * (the verbs store `jev` itself), so nothing un-serializable reaches Model.
 */
export class JevAskFailure extends Error {
  constructor(readonly jev: JevAskErr) {
    super(`jev ask: ${jev._tag}`);
    this.name = "JevAskFailure";
  }
}

/** Read any thrown value back as a {@link JevAskErr}. A foreign throw is transient. */
function toAskErr(error: unknown): JevAskErr {
  if (error instanceof JevAskFailure) return error.jev;
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
  /** DI port — the HTTP caller. Absent = the no-key case; `fallback` answers instead. */
  readonly port?: JevPort<Q>;
  /** The pure decider for the no-port and budget-spent paths. Absent → those settle as an error. */
  readonly fallback?: JevFallback<Q>;
  /** Backoff policy, composed into `../../resilience/resilient-call`. Omit → no backoff. */
  readonly retry?: RetryPolicy;
  /** The model id asked for. Defaults to {@link DEFAULT_JEV_MODEL}. */
  readonly model?: string;
}

/**
 * The settled answer carried on `resilient_ok`.
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
export type JevAskCmd<Q extends JevQuestionMap> = RunCmd<JevRequest<Q>>;

/** The success settle Msg — resilient-call's, with `result` narrowed to {@link JevOk}. */
export type JevSucceedMsg<Q extends JevQuestionMap> = SucceedMsg<JevOk<Q>>;

/** The failure settle Msg — resilient-call's, with `error` narrowed to {@link JevAskErr}. */
export type JevFailMsg = Omit<FailMsg, "error"> & {
  readonly error: JevAskErr;
};

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
 * The slice and five of the six verbs are resilient-call's, forwarded. `fail` is
 * the one composed verb — it reads the {@link JevAskErr} the handler typed and
 * routes on it (see its docblock); it reimplements no backoff. `handlers` is the
 * new piece: the port call, the status classification, the parse, and the
 * enriched settle Msg.
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
  function isErrDecision(decided: JevAnswers<Q> | JevErr): decided is JevErr {
    return isJevErr(decided);
  }

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

  /** Record a settled answer for `key`. PURE — resilient-call's `succeed`. */
  function succeed(
    s: State,
    key: string,
    msg: JevSucceedMsg<Q>,
  ): readonly [State, readonly JevAskCmd<Q>[]] {
    return rc.succeed(s, key, msg);
  }

  /**
   * Settle `key` from the fallback, as if the fallback's answer were the
   * response. PURE — the fallback is a pure decider, and `succeed` / `settleFailed`
   * are resilient-call's own settle verbs. `s` is the state BEFORE the failing
   * attempt was recorded, so the call is still live and `succeed` closes it
   * normally.
   */
  function settleFromFallback(
    s: State,
    key: string,
    request: JevRequest<Q>,
    fallback: JevFallback<Q>,
    at: number,
  ): readonly [State, readonly JevAskCmd<Q>[]] {
    const decided = fallback(request);
    if (isErrDecision(decided)) return rc.settleFailed(s, key, decided);
    return rc.succeed(s, key, {
      type: MsgType.ResilientOk,
      key,
      result: {
        answers: decided,
        model: request.model,
        usage: NO_USAGE,
        source: "fallback",
      },
      at,
    });
  }

  /**
   * Record a failure for `key`. PURE. The backoff itself is resilient-call's —
   * nothing here recomputes a delay, counts an attempt or reads a clock. What
   * this verb adds is the routing the typed error makes possible, and it is two
   * decisions:
   *
   *   1. A TERMINAL error settles through `settleFailed`, which ends the call
   *      without touching the breaker or the retry counter. Handing a 401 or a
   *      parse failure to `fail` instead would re-issue the identical request
   *      and trip a breaker over a backend that is perfectly healthy.
   *   2. When the transient path EXHAUSTS the retry budget and a `fallback` is
   *      configured, the fallback answers instead of the call settling failed.
   *      This is the one place that can be observed — exhaustion is a fact of
   *      the slice, not of the handler, so the handler cannot know it is on the
   *      last attempt.
   */
  function fail(
    s: State,
    key: string,
    msg: JevFailMsg,
  ): readonly [State, readonly JevAskCmd<Q>[]] {
    if (!isTransientJevAskErr(msg.error)) {
      return rc.settleFailed(s, key, msg.error);
    }
    const request = liveRequest(s, key);
    const settled = rc.fail(s, key, msg);
    const backedOff = settled[0].calls[key]?.phase !== "failed";
    if (backedOff || config.fallback === undefined || request === undefined) {
      return settled;
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

  /** Pre-wired subs — resilient-call's retry-timer subscriptions. */
  function subs(s: State): readonly DeadlineSub[] {
    return rc.subs(s);
  }

  // ---- The port the resilient handler drives -----------------------------

  /**
   * Run ONE ask: call the port, classify the status, parse the body against the
   * questions that produced it. Resolves to the typed {@link JevOk}; throws a
   * {@link JevAskFailure} on every failure, because throwing is how
   * resilient-call is told an attempt failed. `fail` reads the carried
   * {@link JevAskErr} back and decides whether the throw was worth retrying.
   *
   * With no `port` this is the fallback's whole story: no HTTP call is made, and
   * with no fallback either the knob says so as `no_answer_path` rather than
   * pretending a network failure.
   */
  async function ask(
    request: JevRequest<Q>,
    signal?: AbortSignal,
  ): Promise<JevOk<Q>> {
    if (config.port === undefined) {
      if (config.fallback === undefined) {
        throw new JevAskFailure({ _tag: "no_answer_path" });
      }
      const decided = config.fallback(request);
      if (isErrDecision(decided)) throw new JevAskFailure(decided);
      return {
        answers: decided,
        model: request.model,
        usage: NO_USAGE,
        source: "fallback",
      };
    }

    const { status, body } = await config.port(request, signal);
    const kind = classifyStatus(status);
    if (kind === "retry")
      throw new JevAskFailure({ _tag: "http_retry", status });
    if (kind === "terminal") {
      throw new JevAskFailure({ _tag: "http_terminal", status });
    }

    const parsed = parseAnswers(config.questions, body);
    if (!parsed.ok) throw new JevAskFailure(parsed.error);
    return {
      answers: parsed.answers,
      model: parsed.model,
      usage: parsed.usage,
      source: "port",
    };
  }

  // ---- Handlers ----------------------------------------------------------

  // resilient-call's `resilient_run` handler over `ask` — the shared
  // Railway-routed invoke (Ok → `resilient_ok`, Err → `resilient_err`), stamped
  // with the one `Date.now()` this module makes, at the effect boundary.
  const resilientRunHandler = rc.handlers({
    run: (request) => ask(request),
  }).resilient_run;

  /**
   * Await one invoke and resolve to the ENRICHED settle Msg. The success Msg is
   * resilient-call's as-is (`ask` already returns the typed {@link JevOk}); the
   * failure Msg is its `error: unknown` read back as the typed
   * {@link JevAskErr}, so the host reducer — and `fail` — route on a tag rather
   * than on a stringified throw.
   */
  async function settleOf(
    cmd: JevAskCmd<Q>,
  ): Promise<JevSucceedMsg<Q> | JevFailMsg> {
    const settle = await resilientRunHandler(cmd, {});
    if (settle.type === MsgType.ResilientOk) return settle;
    return {
      type: MsgType.ResilientErr,
      key: settle.key,
      error: toAskErr(settle.error),
      at: settle.at,
    };
  }

  /**
   * Pre-wired interpret handler for `resilient_run`. It RETURNS the settle Msg
   * rather than dispatching one: the substrate enqueues an interpret handler's
   * returned Msg as a follow-up onto the dispatch tail, so the host's
   * `resilient_ok` / `resilient_err` arms run `succeed` / `fail` and the
   * inherited backoff loop advances. A handler that dispatched instead would
   * settle one invoke and leave the slice wedged at `running`.
   */
  function handlers(): {
    resilient_run: (
      cmd: JevAskCmd<Q>,
    ) => Promise<JevSucceedMsg<Q> | JevFailMsg>;
  } {
    return { resilient_run: (cmd: JevAskCmd<Q>) => settleOf(cmd) };
  }

  return {
    name: rc.name,
    init,
    attempt,
    succeed,
    fail,
    onTimer,
    subs,
    handlers,
    ask,
  };
}

/**
 * The Cmd type a host machine declares in `types.cmd` when it splices a
 * {@link createJevAsk} knob in — {@link JevAskCmd} under the name a `types`
 * block reads well with. It is stated here so a host writes `cmd: {} as
 * JevCmd<Questions>` rather than deriving it from the knob's shape, which is
 * what `ReturnType<Ask["attempt"]>[1][number]` used to be doing at every call
 * site: a spelling of the same type that breaks the moment `attempt`'s tuple
 * changes, and that reads as machinery rather than as a name.
 */
export type JevCmd<Q extends JevQuestionMap> = JevAskCmd<Q>;

/**
 * The Sub type a host machine declares in `types.sub` — the deadline Sub
 * `subs` emits, inherited from resilient-call. Named here for the same reason
 * as {@link JevCmd}: a host names the type, it does not re-derive it.
 */
export type JevSub = DeadlineSub;

/**
 * Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the slice
 * lives at `state.resilience` — resilient-call's convenience, re-typed for this
 * door's slice so a consumer wires one import. Pure.
 */
export function liftJevAsk<
  S extends { resilience: ResilientState<JevRequest<Q>, JevOk<Q>> },
  Q extends JevQuestionMap,
  C extends Cmd,
>(
  state: S,
  result: readonly [ResilientState<JevRequest<Q>, JevOk<Q>>, readonly C[]],
): readonly [S, readonly C[]] {
  return liftResilience(state, result);
}

/**
 * Re-export the deadline Sub primitives (inherited from resilient-call) so a
 * consumer wires one import: `subscribeDeadline` is the `subscribe` cell,
 * `deadlineSub` builds the Sub literal `subs` emits. `mountResilientCall` rides
 * the same import for the same reason — a knob from this door mounts with no
 * second package specifier.
 */
export { subscribeDeadline, deadlineSub, mountResilientCall };
export type { DeadlineSub, DeadlineExceeded, ResilientState };
