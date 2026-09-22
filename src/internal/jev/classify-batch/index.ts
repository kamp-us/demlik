/**
 * @packageDocumentation
 * internal/jev/classify-batch — the composition that turns a stream of items
 * into Jev calls. Internal since #218 — not published on any subpath.
 *
 * It writes NO chunker, NO cache, NO concurrency limiter and NO retry. Every
 * one of those already exists as a battery, and this module is the wiring:
 *
 *   - `../../flow/batch-window` coalesces `add(item, at)` calls into size- or
 *     time-bounded batches (`maxItems`, `maxMs`).
 *   - `../../flow/fan-out` bounds how many batches are in flight
 *     (`concurrency`), keyed by a batch id that is a pure function of the
 *     batch's item keys.
 *   - `../../resilience/cache` is the TTL cache keyed by `keyOf(item)`. An item
 *     whose key is cached never enters a batch; every settled answer is written
 *     back with `ttlMs`.
 *   - `../ask` is the one effect: each flushed batch becomes one `resilient_run`
 *     Cmd carrying Jev's NATIVE batch form (grill #215, R1.2) — the item array
 *     IS the request `state`, and `questions` holds one `choice` question per
 *     item, keyed by `keyOf(item)`. There is no `{ transactions }` envelope of
 *     any kind.
 *
 * ## The slice is plain data, and time arrives as `at`
 *
 * {@link ClassifyBatchState} is the three batteries' own slices plus a failure
 * map, so it survives a `Store` rehydrate unchanged. Every transition is a Msg
 * through the verbs (`add`, `onWindow`, `onBatchOk`, `onBatchErr`, `onEvict`);
 * no verb reads a clock, and the one `Date.now()` on the path is the one
 * `../ask`'s interpret handler already stamps at the effect boundary.
 *
 * ## What this module deliberately does not decide
 *
 * `answerFor` is a derived READ. It reports `answered` / `failed` / `pending` /
 * `absent` and hands back the choice answer with its own `confidence`; whether
 * a given confidence auto-assigns or goes to triage is the HOST reducer's rule,
 * and putting a threshold here would make one caller's policy everybody's.
 *
 * ## Typical wiring
 *
 *   const classify = createClassifyBatch({
 *     keyOf: (t) => sanitizedMerchant(t),
 *     criteria: { groceries: "Supermarkets", dining: "Restaurants" },
 *     maxItems: 25,
 *     maxMs: 2_000,
 *     concurrency: 4,
 *     ttlMs: 86_400_000,
 *     port: fetchJevPort(apiKey),
 *   });
 *
 *   update: {
 *     classify_add: (s, m) => lift(s, classify.add(s.classify, m.item, m.at)),
 *     deadline_exceeded: (s, m) => lift(s, classify.onWindow(s.classify, m.atMs)),
 *     resilient_ok: (s, m) => lift(s, classify.onBatchOk(s.classify, m)),
 *     resilient_err: (s, m) => lift(s, classify.onBatchErr(s.classify, m)),
 *     cache_evict: (s, m) => lift(s, classify.onEvict(s.classify, nowFromMsg)),
 *   },
 *   subscriptions: (s) => classify.subs(s.classify),
 *   subscribe: classify.subscribers(),
 *   interpret: classify.handlers(),
 */

import type { Cmd } from "../../../index";
import {
  type BatchWindow,
  type BatchWindowSub,
  createBatchWindow,
  subscribeBatchWindow,
} from "../../flow/batch-window";
import { createFanOut, type FanOutState } from "../../flow/fan-out";
import {
  type CacheEvictionSub,
  cacheEvictionSub,
  cacheEvictionSubscribe,
  get as cacheGet,
  has as cacheHas,
  set as cacheSet,
  evictExpired,
  initCache,
  type TtlCache,
} from "../../resilience/cache";
import {
  createJevAsk,
  DEFAULT_JEV_MODEL,
  type JevAskCmd,
  type JevAskErr,
  type JevFailMsg,
  type JevFallback,
  type JevOk,
  type JevPort,
  type JevSucceedMsg,
  jevAskCmdDef,
} from "../ask";
import type {
  JevAnswerFor,
  JevChoiceQuestion,
  JevRequest,
  JevText,
} from "../protocol";

// ===========================================================================
// The question shape one item gets.
// ===========================================================================

/**
 * The rubric every item is classified against: option key → description, or
 * `null` where an option needs no extra detail. `C` is the option union, and it
 * is what makes an answer's `choice` narrow at the call site.
 */
export type ClassifyCriteria<C extends string> = Readonly<
  Record<C, JevText | null>
>;

/** The one `choice` question an item is asked. */
export type ItemQuestion<C extends string> = JevChoiceQuestion<
  ClassifyCriteria<C>
>;

/**
 * The `questions` map of one batch: one {@link ItemQuestion} per item, keyed by
 * `keyOf(item)`. This IS Jev's native batch form — the questions map is the
 * fan-out over items, so nothing here wraps the items in an envelope of its own.
 */
export type ItemQuestions<C extends string> = Readonly<
  Record<string, ItemQuestion<C>>
>;

/** The answer one item's question yields. */
export type ItemAnswer<C extends string> = JevAnswerFor<ItemQuestion<C>>;

// ===========================================================================
// Batches, Cmds and Msgs.
// ===========================================================================

/**
 * One flushed batch, as plain data: the items and the id fan-out addresses it
 * by. `id` is a pure function of the batch's item keys (they are joined with a
 * separator no sanitized key contains), which is what lets a settle Msg — whose
 * `key` is that id — find its batch again after a rehydrate.
 */
export interface Batch<I> {
  readonly id: string;
  readonly items: readonly I[];
}

/** The Cmd a flushed batch becomes — `../ask`'s, carrying the native request. */
export type ClassifyBatchCmd<C extends string> = JevAskCmd<ItemQuestions<C>>;

/** The success settle Msg — `../ask`'s, with the batch's answers. */
export type ClassifyBatchOkMsg<C extends string> = JevSucceedMsg<
  ItemQuestions<C>
>;

/** The failure settle Msg — `../ask`'s, with the typed {@link JevAskErr}. */
export type ClassifyBatchErrMsg = JevFailMsg;

/**
 * The internal Cmd the batch window flushes into. It never leaves this module:
 * `add` and `onWindow` intercept it and hand the items to fan-out, which is
 * what bounds how many batches are in flight. Letting the window emit the ask
 * Cmd directly would flush straight past `concurrency`.
 */
type FlushCmd<I> = Cmd<"classify_batch_flush"> & {
  readonly items: readonly I[];
};

// ===========================================================================
// Config and slice.
// ===========================================================================

/** The default page size — the one the grill settled on for Jev. */
export const DEFAULT_CLASSIFY_MAX_ITEMS = 25;

/** The knob. Every field is a policy this module refuses to invent. */
export interface ClassifyBatchConfig<I, C extends string> {
  /**
   * The cache key and the question id of an item — e.g. a sanitized merchant
   * string, so two transactions at the same shop share one answer. PURE.
   */
  readonly keyOf: (item: I) => string;
  /** The rubric every item is classified against. Its keys are the answer domain. */
  readonly criteria: ClassifyCriteria<C>;
  /**
   * The `instructions` for one item's question. Defaults to a template naming
   * the item's key, which is what tells the model WHICH element of the request
   * `state` the question is about.
   */
  readonly instructions?: (key: string, item: I) => JevText;
  /** Size trigger, forwarded to the batch window. Defaults to {@link DEFAULT_CLASSIFY_MAX_ITEMS}. */
  readonly maxItems?: number;
  /** Latency ceiling in ms, forwarded to the batch window. */
  readonly maxMs: number;
  /** Max batches in flight, forwarded to fan-out. */
  readonly concurrency: number;
  /** How long a settled answer stays cached, forwarded to the TTL cache. */
  readonly ttlMs: number;
  /** Eviction tick for the TTL cache. Omit and no eviction Sub is declared. */
  readonly evictEveryMs?: number;
  /** The model asked for. Forwarded to `../ask`'s default when omitted. */
  readonly model?: string;
  /** DI port — the HTTP caller. Forwarded to `../ask`; absent is the no-key case. */
  readonly port?: JevPort<ItemQuestions<C>>;
  /** The pure decider for the no-port path. Forwarded to `../ask`. */
  readonly fallback?: JevFallback<ItemQuestions<C>>;
}

/**
 * The slice: the three batteries' own slices, plus the one fact none of them
 * holds — which keys a failed batch left unanswered. All plain data.
 */
export interface ClassifyBatchState<I, C extends string> {
  /** The open batch window — `../../flow/batch-window`'s slice. */
  readonly window: BatchWindow<I>;
  /** The in-flight batches — `../../flow/fan-out`'s slice. */
  readonly fanOut: FanOutState<Batch<I>, JevOk<ItemQuestions<C>>>;
  /** The answers, keyed by `keyOf` — `../../resilience/cache`'s slice. */
  readonly cache: TtlCache<ItemAnswer<C>>;
  /** Keys whose batch settled `resilient_err`, with the error that settled it. */
  readonly failed: Readonly<Record<string, JevAskErr>>;
}

/** What {@link ClassifyBatchKnob.answerFor} reports about one key. */
export type KeyAnswer<C extends string> =
  /** Answered and unexpired: the host applies its own confidence rule to this. */
  | { readonly status: "answered"; readonly answer: ItemAnswer<C> }
  /** The batch carrying this key settled `resilient_err`. Nothing was cached. */
  | { readonly status: "failed"; readonly error: JevAskErr }
  /** Buffered in the open window, or in a batch that has not settled. */
  | { readonly status: "pending" }
  /** Never seen, or cached and now expired. */
  | { readonly status: "absent" };

// ===========================================================================
// The knob factory.
// ===========================================================================

/**
 * Build a classify-batch knob from `config`.
 *
 * The verbs are pure and the whole composition is the four batteries'; the only
 * thing this factory adds is the native-batch request shape and the bookkeeping
 * that keeps one key out of two batches at once.
 */
export function createClassifyBatch<I, C extends string>(
  config: ClassifyBatchConfig<I, C>,
) {
  type State = ClassifyBatchState<I, C>;
  type AskOk = JevOk<ItemQuestions<C>>;
  type Cmds = readonly ClassifyBatchCmd<C>[];

  const maxItems = config.maxItems ?? DEFAULT_CLASSIFY_MAX_ITEMS;
  const askCmd = jevAskCmdDef<ItemQuestions<C>>();
  const instructionsFor =
    config.instructions ??
    ((key: string): JevText =>
      `Classify the element of \`state\` whose key is "${key}".`);

  /** The batch's identity: its item keys, in arrival order. PURE. */
  function idOfBatch(batch: Batch<I>): string {
    return batch.id;
  }

  /** One batch's `questions` map — one choice question per item, keyed by `keyOf`. */
  function questionsFor(items: readonly I[]): ItemQuestions<C> {
    const questions: Record<string, ItemQuestion<C>> = {};
    for (const item of items) {
      const key = config.keyOf(item);
      questions[key] = {
        type: "choice",
        instructions: instructionsFor(key, item),
        criteria: config.criteria,
      };
    }
    return questions;
  }

  /**
   * The native Jev request for a batch: the item array IS the `state`, and the
   * questions map is the per-item fan-out. No envelope.
   */
  function requestFor(batch: Batch<I>): JevRequest<ItemQuestions<C>> {
    return {
      state: batch.items,
      model: config.model ?? DEFAULT_JEV_MODEL,
      questions: questionsFor(batch.items),
    };
  }

  const fanOut = createFanOut<
    Batch<I>,
    AskOk,
    ClassifyBatchCmd<C>,
    ClassifyBatchCmd<C>
  >({
    concurrency: config.concurrency,
    idOf: idOfBatch,
    of: (batch) => askCmd({ key: batch.id, input: requestFor(batch) }),
  });

  const window = createBatchWindow<I, FlushCmd<I>>({
    maxItems,
    maxMs: config.maxMs,
    flush: (items) => ({ type: "classify_batch_flush", items }),
  });

  /** The starting slice — each battery's own `init`, side by side. */
  function init(): State {
    return {
      window: window.init(),
      fanOut: fanOut.init(),
      cache: initCache<ItemAnswer<C>>(),
      failed: {},
    };
  }

  /** Every key currently buffered or in flight. PURE. */
  function keysInFlight(state: State): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const item of state.window.buffer) keys.add(config.keyOf(item));
    for (const batch of state.fanOut.pending) {
      for (const item of batch.items) keys.add(config.keyOf(item));
    }
    for (const batch of state.fanOut.running) {
      for (const item of batch.items) keys.add(config.keyOf(item));
    }
    return keys;
  }

  /** The running batch a settle Msg's `key` addresses, or `undefined`. PURE. */
  function runningBatch(state: State, id: string): Batch<I> | undefined {
    return state.fanOut.running.find((batch) => batch.id === id);
  }

  /**
   * Hand a flushed window's items to fan-out. Fan-out returns the launch Cmds —
   * at most `concurrency` of them — so a window that flushes while the budget is
   * spent parks its batch in `pending` and launches nothing.
   */
  function scatter(
    state: State,
    flushed: readonly FlushCmd<I>[],
  ): readonly [State, Cmds] {
    if (flushed.length === 0) return [state, []];
    const batches = flushed.map((cmd) => ({
      id: cmd.items.map(config.keyOf).join("\u0000"),
      items: cmd.items,
    }));
    const [next, cmds] = fanOut.scatter(state.fanOut, batches);
    return [{ ...state, fanOut: next }, cmds];
  }

  /**
   * Offer `item` to the pipeline at `at`. PURE.
   *
   * An item whose key is cached, buffered, or already in a batch is DROPPED:
   * the cache hit is the whole point of the cache, and the other two are what
   * keeps one key out of two batches at once — which is the property that makes
   * a batch's id a usable identity and an answer's key unambiguous.
   */
  function add(state: State, item: I, at: number): readonly [State, Cmds] {
    const key = config.keyOf(item);
    if (cacheHas(state.cache, key, at)) return [state, []];
    if (keysInFlight(state).has(key)) return [state, []];

    const [nextWindow, flushed] = window.add(state.window, item, at);
    return scatter({ ...state, window: nextWindow }, flushed);
  }

  /** The time window closed: flush whatever is buffered. PURE. */
  function onWindow(state: State, at: number): readonly [State, Cmds] {
    const [nextWindow, flushed] = window.onWindow(state.window, at);
    return scatter({ ...state, window: nextWindow }, flushed);
  }

  /**
   * A batch settled OK. PURE.
   *
   * Every answer is written back to the cache with `ttlMs` at `msg.at`, the
   * batch's keys lose any standing failure mark, and fan-out backfills the freed
   * concurrency slot — so the returned Cmds are the next batches' asks.
   *
   * An answer arrives under the question id it was asked under, which is the
   * item's own key, so the write-back needs no positional matching between the
   * request `state` array and the answers map.
   */
  function onBatchOk(
    state: State,
    msg: ClassifyBatchOkMsg<C>,
  ): readonly [State, Cmds] {
    let cache = state.cache;
    for (const [key, answer] of Object.entries(msg.result.answers)) {
      cache = cacheSet(cache, key, answer, msg.at, config.ttlMs);
    }
    const failed: Record<string, JevAskErr> = { ...state.failed };
    for (const key of Object.keys(msg.result.answers)) delete failed[key];

    const [nextFanOut, cmds] = fanOut.itemOk(state.fanOut, msg.key, msg.result);
    return [{ ...state, cache, failed, fanOut: nextFanOut }, cmds];
  }

  /**
   * A batch settled `resilient_err`. PURE.
   *
   * Each of its keys is marked failed with the error that settled it and the
   * cache is NOT touched: a failure is not an answer, and writing one back under
   * `ttlMs` would poison every later `add` for that key for the whole TTL. The
   * key stays re-addable, because it is neither cached nor in flight once
   * fan-out has moved the batch to `failed`.
   */
  function onBatchErr(
    state: State,
    msg: ClassifyBatchErrMsg,
  ): readonly [State, Cmds] {
    const batch = runningBatch(state, msg.key);
    const failed: Record<string, JevAskErr> = { ...state.failed };
    if (batch !== undefined) {
      for (const item of batch.items) failed[config.keyOf(item)] = msg.error;
    }
    const [nextFanOut, cmds] = fanOut.itemErr(state.fanOut, msg.key, msg.error);
    return [{ ...state, failed, fanOut: nextFanOut }, cmds];
  }

  /** The eviction tick fired: drop every entry expired at `at`. PURE. */
  function onEvict(state: State, at: number): readonly [State, Cmds] {
    return [{ ...state, cache: evictExpired(state.cache, at) }, []];
  }

  /**
   * What is known about `key` at `at`. PURE, derived — it stores nothing.
   *
   * `at` is a parameter rather than a clock read because a TTL answer is only
   * an answer relative to an instant, and this module reads no clock anywhere.
   * The host passes the `at` of the Msg it is handling.
   */
  function answerFor(state: State, key: string, at: number): KeyAnswer<C> {
    const answer = cacheGet(state.cache, key, at);
    if (answer !== undefined) return { status: "answered", answer };
    const error = state.failed[key];
    if (error !== undefined) return { status: "failed", error };
    if (keysInFlight(state).has(key)) return { status: "pending" };
    return { status: "absent" };
  }

  /**
   * The Subs — the window's flush timer, plus the cache's eviction tick when
   * `evictEveryMs` is configured. Fan-out declares none (it runs no timers).
   */
  function subs(
    state: State,
    id = "jev-classify-batch",
  ): readonly (BatchWindowSub | CacheEvictionSub)[] {
    const windowSubs = window.subs(state.window, id);
    if (config.evictEveryMs === undefined) return windowSubs;
    return [...windowSubs, cacheEvictionSub(id, config.evictEveryMs)];
  }

  /** The `subscribe` cells the Subs above need. */
  function subscribers() {
    return { deadline: subscribeBatchWindow, cache: cacheEvictionSubscribe };
  }

  /**
   * The interpret handler for the ask Cmd. The port call, the status
   * classification and the parse are ALL `../ask`'s — this seam only builds the
   * ask knob around the questions the Cmd is carrying, because a batch's
   * question map is minted per batch while `createJevAsk` takes one map per
   * knob. The knob is built at the effect boundary, so nothing impure and
   * nothing closure-shaped ever reaches the slice.
   */
  function handlers(): {
    resilient_run: (
      cmd: ClassifyBatchCmd<C>,
    ) => Promise<ClassifyBatchOkMsg<C> | ClassifyBatchErrMsg>;
  } {
    return {
      resilient_run: (cmd) => {
        const request = cmd.input as JevRequest<ItemQuestions<C>>;
        const ask = createJevAsk<ItemQuestions<C>>({
          questions: request.questions,
          ...(config.port === undefined ? {} : { port: config.port }),
          ...(config.fallback === undefined
            ? {}
            : { fallback: config.fallback }),
          ...(config.model === undefined ? {} : { model: config.model }),
        });
        return ask.handlers().resilient_run(cmd);
      },
    };
  }

  return {
    init,
    add,
    onWindow,
    onBatchOk,
    onBatchErr,
    onEvict,
    answerFor,
    subs,
    subscribers,
    handlers,
  };
}

/** The bound knob {@link createClassifyBatch} returns. */
export type ClassifyBatchKnob<I, C extends string> = ReturnType<
  typeof createClassifyBatch<I, C>
>;
