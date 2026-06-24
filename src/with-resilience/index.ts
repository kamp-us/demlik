/**
 * @demlik/tea/with-resilience — the INTERCEPTING wrapper of the wrapper tier.
 *
 * `withResilience(base, config)` is a **pure function over machine data**: it
 * takes any `Machine<S, M, C, U, Ctx>`, a chosen TARGET base Cmd type, and a
 * resilience knob, and returns a NEW `Machine` over the composed Model
 * `{ base, $resilience }`. You `run()` / `replay()` the result exactly like any
 * other machine — there is no new runtime, no privileged interception path.
 *
 * This is the HARDEST wrapper. `withTelemetry` only OBSERVES; this one
 * INTERCEPTS. It bolts the resilient-call concern (cache → circuit-breaker →
 * rate-limit → exponential-backoff retry, with a deadline cap) onto a chosen
 * base Cmd WITHOUT the base authoring any of it. The base keeps emitting its
 * plain effect Cmd; the wrapper diverts each one through the resilience gate.
 *
 * ## Retag, never swallow (rule 2 — the whole danger)
 *
 * The merged `update` delegates to `base.update`, then PARTITIONS the base Cmds
 * by type:
 *
 *   - A NON-target base Cmd passes through UNCHANGED — byte-identical, in the
 *     same slot. The wrapper does not touch effects it was not asked to harden.
 *   - A TARGET base Cmd is RETAGGED: it becomes the `input` payload of a
 *     `$resilience:run` carrier Cmd (when the gate admits it), OR its gating is
 *     RECORDED as a `$resilience:*` decision in the SAME transition (cache hit,
 *     circuit-open fast-fail, rate-limited backoff). It is NEVER emitted raw,
 *     and it NEVER vanishes without a `$resilience:*` Cmd recording where it
 *     went. That recorded divergence is exactly what the conformance gate's
 *     `intercepting` option verifies.
 *
 * The resilient-call result Msgs route back through the merged `update`:
 * `$resilience:ok` → `succeed` (close the breaker, fill the cache, reset the
 * retry run), `$resilience:err` → `fail` (trip the breaker, then back off or
 * settle), `$resilience:timer` → `onTimer` (a retry timer re-runs the gate; a
 * deadline timer settles the call failed). Every decision is a Msg/Cmd through
 * the reducer + log — "why did this fire" is answerable from the log alone.
 *
 * ## The slice + verbs are REUSED, not reinvented
 *
 * The `$resilience` slice IS resilient-call's `ResilientState<I, R>` (per-key
 * call / retry / circuit / bucket / cache), and the gate / backoff / breaker
 * logic IS its `attempt` / `succeed` / `fail` / `onTimer` verbs + `subs`. The
 * wrapper only ADAPTS the boundary: the verb's `input` is the ORIGINAL base
 * Cmd, the verb's `resilient_run` carrier is renamed to `$resilience:run`, and
 * the sub / timer ids are re-keyed into the `$resilience:` namespace (rule 4).
 *
 * ## The 5 rules it satisfies
 *
 *   1. **Named, serializable slice.** `model.$resilience` is resilient-call's
 *      plain-data `ResilientState` — JSON-serializable (the deadline error is a
 *      `{_tag,...}` sentinel, never a `new Error`), never a closure.
 *   2. **Retag-and-re-emit, never swallow.** See above — a target base Cmd is
 *      always inside a `$resilience:run` inner payload or recorded by a
 *      `$resilience:*` divergence Cmd in the same transition.
 *   3. **Every decision is a Msg/Cmd.** Gate / retry-schedule / fast-fail /
 *      settle are all `$resilience:*` Cmds and Msgs through the merged `update`.
 *   4. **Subs merge by id.** Base subs ⧺ resilient-call retry/deadline timers,
 *      re-keyed `$resilience:retry:{key}` / `$resilience:deadline:{key}`.
 *   5. **Clock out of update.** Backoff jitter RNG is injected at construction;
 *      the only clock read is `Date.now()` at the interpret boundary (the
 *      `$resilience:run` handler stamps the ok/err Msg `at`) and in the timer
 *      Sub. The merged `update` is PURE — `at` arrives as Msg data.
 */

import { type DeadlineSub, subscribeDeadline } from "../deadline";
import type { Cmd, Interpret, Machine, Reducer, Sub } from "../index";
import { subId, tryInterpret } from "../index";
import { MsgType } from "../protocol";
import {
  createResilientCall,
  type ResilientConfig,
  type ResilientState,
} from "../resilient-call";

// ===========================================================================
// Config — the target + the resilience knob + an optional key deriver.
// ===========================================================================

/**
 * The `withResilience` knob. Extends resilient-call's `ResilientConfig` (every
 * brick optional — omit a brick, omit its gate) with the two fields the wrapper
 * needs that the bare knob does not:
 *
 *   - `target` — the `Cmd.type` discriminant of the ONE base Cmd this wrapper
 *     hardens. Every other base Cmd passes through untouched.
 *   - `keyOf` — OPTIONAL. Derives the per-call resilience `key` from the target
 *     base Cmd, so distinct logical calls (distinct urls, distinct ids) get
 *     independent retry / cache state. Pure — it runs inside the merged
 *     `update`, so it must NOT read the clock / RNG. Defaults to a single
 *     shared key (`target`), i.e. one logical call at a time.
 */
export interface ResilienceConfig<TC extends Cmd, TM extends { type: string }>
  extends ResilientConfig {
  /** The base `Cmd.type` to make resilient. */
  readonly target: TC["type"];
  /** Optional per-call key deriver. Pure. Defaults to the target type itself. */
  readonly keyOf?: (cmd: TC) => string;
  /**
   * Extracts the real wall-clock time (ms) the TRIGGERING base Msg carries as
   * data — the time-as-data convention `resilient-call` expects on `attempt`.
   *
   * The merged `update` is PURE: it cannot read `Date.now()` (rule 5). The COLD
   * attempt's gate (the very first `attempt` for a target Cmd in a transition)
   * still needs a real instant — the breaker compares `at` against its recorded
   * `openedAtMs`, the cache against its write `at`, the bucket against its last
   * refill `at`, and the deadline cap anchors at `at + deadline.ms`. Fabricating
   * `at = 0` is the betrayal: a cold attempt after a real-time breaker trip then
   * computes cooldown = `0 - realTripTime < 0` forever, so the breaker NEVER
   * recovers, and a `0`-anchored deadline brick fires immediately.
   *
   * So the base Msg that drove this transition MUST carry its own wall time as
   * data, and `at` reads it off that Msg. The merged update passes
   * `at(currentBaseMsg)` into `rc.attempt` for every target Cmd that transition
   * emitted — real time enters the cold gate as Msg data, never `0`.
   *
   * REQUIRED whenever any time-sensitive brick (`circuit`, `rateLimit`, `cache`,
   * `deadline`) is configured — `withResilience` THROWS at construction if such
   * a brick is set and `at` is absent (errors are data: the cold gate needs real
   * time, refuse to build a breaker that can never recover). OPTIONAL when only
   * `retry` is configured: retry backoff reads its time off the result / timer
   * Msgs (`$resilience:err.at`, `$resilience:timer.atMs`), never the cold attempt
   * — so a `0` cold `at` is harmless there. Pure: it runs inside the merged
   * `update`, so it must NOT read the clock / RNG.
   */
  readonly at?: (msg: TM) => number;
}

// ===========================================================================
// The slice + the wrapper Cmds/Msgs/Subs/Ports vocabulary.
// ===========================================================================

/**
 * The composed Model. The base machine's state nests under `base`; the wrapper
 * owns the NAMED `$resilience` slice — resilient-call's `ResilientState` keyed
 * by the per-call `key`, with `I = TC` (the original target base Cmd is the
 * port input) and `R = unknown` (the base interpret handler's result is opaque
 * to the wrapper — it only routes Ok/Err). Plain data → round-trips through
 * `JSON.parse(JSON.stringify(...))` iff the base state does.
 */
export interface ResilienceModel<S, TC extends Cmd> {
  readonly base: S;
  readonly $resilience: ResilientState<TC, unknown>;
}

/**
 * The carrier Cmd the wrapper emits when the gate ADMITS a target base Cmd. It
 * RETAGS the original base Cmd into `input` — the base Cmd is plain data, so no
 * closure (invariant 3). The interpret handler unwraps `input` and runs it
 * through the BASE interpret for that Cmd type. `key` indexes the resilient
 * call this run belongs to.
 */
export type ResilienceRunCmd<TC extends Cmd> = Cmd<"$resilience:run"> & {
  readonly key: string;
  /** The ORIGINAL base Cmd, retagged — never swallowed. */
  readonly input: TC;
};

/**
 * The success Msg the `$resilience:run` handler dispatches back when the base
 * interpret resolved OK. Routes to `succeed`. `at` is stamped at the interpret
 * boundary (the one permitted clock read).
 */
export type ResilienceOkMsg = {
  readonly type: "$resilience:ok";
  readonly key: string;
  readonly result: unknown;
  readonly at: number;
};

/**
 * The error Msg the `$resilience:run` handler dispatches back when the base
 * interpret threw / rejected. Routes to `fail` (trip the breaker, then back off
 * or settle). `at` is stamped at the interpret boundary.
 */
export type ResilienceErrMsg = {
  readonly type: "$resilience:err";
  readonly key: string;
  readonly error: unknown;
  readonly at: number;
};

/**
 * The retry / deadline timer Msg the `$resilience:timer` Sub dispatches when
 * the wall clock crosses the armed instant. Routes to `onTimer`. `id` is the
 * `$resilience:`-namespaced timer id; `atMs` is the fire instant (Msg data, the
 * clock that drove it lives in the Sub).
 */
export type ResilienceTimerMsg = {
  readonly type: "$resilience:timer";
  readonly id: string;
  readonly atMs: number;
};

/** Every Msg the wrapper adds to the base's Msg union. */
export type ResilienceMsg =
  | ResilienceOkMsg
  | ResilienceErrMsg
  | ResilienceTimerMsg;

/** Every Cmd the wrapper adds to the base's Cmd union. */
export type ResilienceCmd<TC extends Cmd> = ResilienceRunCmd<TC>;

/** The Sub the wrapper adds — a deadline-style timer in the `$resilience` family. */
export type ResilienceTimerSub = Sub<"$resilience:timer"> & {
  readonly atMs: number;
};

// ===========================================================================
// Boundary re-keying — the resilient-call namespace ↔ the `$resilience` one.
// ===========================================================================

// resilient-call emits its carrier as `resilient_run` and keys its timer Subs
// `resilient:retry:{key}` / `resilient:deadline:{key}`. The wrapper presents the
// `$resilience:` namespace to the outside world (rule 4) while REUSING the
// unmodified verbs underneath. These two pure string maps are the only seam:
// rename the carrier on the way OUT, re-key the timer id on the way IN.

const RC_RETRY_PREFIX = "resilient:retry:";
const RC_DEADLINE_PREFIX = "resilient:deadline:";
const WX_RETRY_PREFIX = "$resilience:retry:";
const WX_DEADLINE_PREFIX = "$resilience:deadline:";

/** resilient-call internal sub id → the `$resilience:`-namespaced public id. */
function toWrapperTimerId(rcId: string): string {
  if (rcId.startsWith(RC_RETRY_PREFIX))
    return WX_RETRY_PREFIX + rcId.slice(RC_RETRY_PREFIX.length);
  if (rcId.startsWith(RC_DEADLINE_PREFIX))
    return WX_DEADLINE_PREFIX + rcId.slice(RC_DEADLINE_PREFIX.length);
  return rcId;
}

/** The `$resilience:`-namespaced timer id → the resilient-call internal id. */
function toRcTimerId(wxId: string): string {
  if (wxId.startsWith(WX_RETRY_PREFIX))
    return RC_RETRY_PREFIX + wxId.slice(WX_RETRY_PREFIX.length);
  if (wxId.startsWith(WX_DEADLINE_PREFIX))
    return RC_DEADLINE_PREFIX + wxId.slice(WX_DEADLINE_PREFIX.length);
  return wxId;
}

// ===========================================================================
// update-form dispatch — run the base reducer regardless of its shape.
// (Mirrors withTelemetry's inline form-branching so the wrapper stays
// standalone; the composed Model is never discriminated on `.type`.)
// ===========================================================================

type BaseCellFn<S, M, C extends Cmd> = (
  state: S,
  msg: M,
) => readonly [S, readonly C[]];

/**
 * Invoke the base machine's `update` for `msg` against base `state`, returning
 * the base's `[nextBase, baseCmds]` UNCHANGED. Pure — routes to the base cell;
 * never reads the clock, allocates an Error, or mutates state.
 */
function runBaseUpdate<S, M extends { type: string }, C extends Cmd>(
  update: object,
  state: S,
  msg: M,
): readonly [S, readonly C[]] {
  const firstKey = Object.keys(update)[0];
  const firstValue =
    firstKey === undefined
      ? undefined
      : (update as Record<string, unknown>)[firstKey];
  if (firstKey === undefined || typeof firstValue === "function") {
    const record = update as unknown as Record<string, BaseCellFn<S, M, C>>;
    // biome-ignore lint/style/noNonNullAssertion: the base Reducer guarantees a cell for every dispatched Msg.type; `!` is required under noUncheckedIndexedAccess and cannot miss for a Msg the base accepts
    return record[msg.type]!(state, msg);
  }
  const table = update as unknown as Record<
    string,
    Record<string, BaseCellFn<S, M, C>>
  >;
  const stateKey = (state as unknown as { type: string }).type;
  // biome-ignore lint/style/noNonNullAssertion: the base Transitions table guarantees every (state.type × msg.type) cell exists; `!` is required under noUncheckedIndexedAccess and cannot miss at runtime
  return table[stateKey]![msg.type]!(state, msg);
}

/** Recover the base Msg.type set from either update form (see withTelemetry). */
function baseMsgKeys(update: object): readonly string[] {
  const keys = Object.keys(update);
  const firstKey = keys[0];
  if (firstKey === undefined) return [];
  const firstValue = (update as Record<string, unknown>)[firstKey];
  if (typeof firstValue === "function") return keys;
  return Object.keys(firstValue as object);
}

/**
 * Does `update` declare `key` as a Msg.type cell, in EITHER update form? The
 * reserved-namespace guard checks the correct level per form (the same
 * detection `baseMsgKeys` / `runBaseUpdate` use):
 *
 *   - Reducer form (`{ [msgType]: cell }`, values are functions) — the
 *     msg-type keys live at the TOP level, so `Object.hasOwn(update, key)`.
 *   - Transitions form (`{ [stateType]: { [msgType]: cell } }`, values are
 *     records) — the msg-type keys live in the INNER tables, one per state.
 *     A reserved msg-type can hide in ANY inner table, so scan EVERY inner
 *     table; a collision in even one inner cell would let a transitions-form
 *     base squat on e.g. an inner `$resilience:ok` cell that the wrapper's
 *     merged update would silently clobber. Top-level `Object.hasOwn` (the
 *     old check) only sees state-type keys here and would MISS it entirely.
 */
function updateDeclaresMsgKey(update: object, key: string): boolean {
  const keys = Object.keys(update);
  const firstKey = keys[0];
  if (firstKey === undefined) return false;
  const firstValue = (update as Record<string, unknown>)[firstKey];
  if (typeof firstValue === "function") {
    // Reducer form — msg-type keys at the top level.
    return Object.hasOwn(update, key);
  }
  // Transitions form — msg-type keys live in each inner state-type table.
  for (const stateKey of keys) {
    const innerTable = (update as Record<string, unknown>)[stateKey];
    if (
      innerTable !== null &&
      typeof innerTable === "object" &&
      Object.hasOwn(innerTable, key)
    ) {
      return true;
    }
  }
  return false;
}

// ===========================================================================
// withResilience — the wrapper.
// ===========================================================================

/**
 * Wrap `base` so its `config.target` Cmd is run through the resilient-call
 * concern (cache → circuit → rate-limit → retry, deadline-capped). Returns a
 * NEW `Machine` over the composed Model `{ base, $resilience }`, with the
 * base's Msgs/Cmds/Subs/Ctx extended by the wrapper's own.
 *
 * @param base   any `Machine<S, M, C, U, Ctx>`.
 * @param config the resilience knob: `target`, the optional bricks, `keyOf`.
 * @param rng    injected backoff jitter source. Pass a fixed `() => 0.5` in
 *               tests to pin retry delays; defaults to `Math.random` (read only
 *               at the verb boundary, never inside the merged `update`).
 */
export function withResilience<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  base: Machine<S, M, C, U, Ctx>,
  config: ResilienceConfig<C, M>,
  rng: () => number = Math.random,
): Machine<
  ResilienceModel<S, C>,
  M | ResilienceMsg,
  C | ResilienceCmd<C>,
  U | ResilienceTimerSub,
  Ctx
> {
  type WM = ResilienceModel<S, C>;
  type WMsg = M | ResilienceMsg;
  type WCmd = C | ResilienceCmd<C>;

  const { target } = config;
  const keyOf = config.keyOf ?? (() => target);

  // A time-sensitive brick gates the COLD attempt against real wall time read
  // off the triggering base Msg (`config.at`). Without `at` the cold gate would
  // have to fabricate `0` — and a cold attempt after a real-time breaker trip
  // then computes cooldown = `0 - realTripTime < 0` forever (the breaker NEVER
  // recovers), while a `0`-anchored deadline fires immediately. Refuse to build
  // such a machine: errors are data, surfaced at construction, never a silent
  // breaker that can't recover. Retry alone reads time off the result/timer
  // Msgs, not the cold attempt, so `at` stays optional there.
  const timeSensitiveBrick =
    config.circuit !== undefined ||
    config.rateLimit !== undefined ||
    config.cache !== undefined ||
    config.deadline !== undefined;
  if (timeSensitiveBrick && config.at === undefined) {
    throw new Error(
      "withResilience: a time-sensitive brick (circuit / rateLimit / cache / " +
        "deadline) is configured but `config.at` is missing. The cold-attempt " +
        "gate needs the REAL wall time the triggering base Msg carries as data " +
        "(time-as-data) — without it the gate would fabricate `at = 0`, so a " +
        "cold attempt after a real-time breaker trip computes a negative " +
        "cooldown and the breaker NEVER recovers (and a deadline brick fires " +
        "immediately). Provide `at: (msg) => msg.<wallTimeField>`.",
    );
  }
  // Read the triggering base Msg's wall time as data for the cold gate. When no
  // time-sensitive brick is configured `at` may be omitted; the cold attempt
  // then gates at `0`, which is harmless because retry backoff reads its time
  // off the result / timer Msgs, never the cold attempt.
  const atOf = config.at ?? (() => 0);

  // The REUSED knob: I = the original target base Cmd, R = the opaque base
  // interpret result. Its verbs / subs / gate are used unmodified; the wrapper
  // only adapts the boundary (carrier rename + timer-id re-keying).
  const rc = createResilientCall<C, unknown>(config, rng);

  // -------------------------------------------------------------------------
  // The merged update — a flat Reducer over the composed (non-discriminated)
  // Model. Cells: every base Msg.type (delegating to base.update + partition),
  // plus the three `$resilience:*` Msgs (delegating to the reused verbs).
  // -------------------------------------------------------------------------

  type Cell = (state: WM, msg: WMsg) => readonly [WM, readonly WCmd[]];
  const update: Record<string, Cell> = {};

  // --- Base-Msg cells: delegate, then PARTITION + retag the target Cmd. ----
  for (const key of baseMsgKeys(base.update)) {
    update[key] = (state, msg) => {
      // 1) Run the base reducer. Its NON-target Cmds pass through unchanged.
      const [nextBase, baseCmds] = runBaseUpdate<S, M, C>(
        base.update,
        state.base,
        msg as M,
      );

      // 2) Partition base Cmds: non-target pass straight through; each target
      //    Cmd is routed through the resilient-call `attempt` gate, which either
      //    emits a `resilient_run` carrier (→ renamed `$resilience:run`,
      //    retagging the ORIGINAL base Cmd into `input`), or records the gate
      //    decision in the slice with NO carrier (cache hit / circuit-open /
      //    rate-limited backoff). Either way the target Cmd never escapes raw
      //    and never vanishes off-ledger.
      let resilience = state.$resilience;
      const outCmds: WCmd[] = [];
      // The COLD attempt's gate time — the REAL wall time the triggering base
      // Msg carries as data (rule 5: the merged `update` stays pure; the clock
      // does not enter here, the Msg's own `at` data does). With this real
      // instant the breaker compares `at - openedAtMs` against its cooldown
      // (set by a prior real-time `$resilience:err`), so a cold attempt during
      // cooldown fast-fails and one AFTER cooldown is admitted — the breaker
      // RECOVERS. The cache compares `at` against its stored write `at`, the
      // bucket refills from `at`, and the deadline cap anchors at
      // `at + deadline.ms` — all against true wall time, never a fabricated
      // `0`. Every SUBSEQUENT gate run (`fail` → backoff, retry-timer
      // `onTimer` → re-gate) reads time off the result / timer Msgs the same
      // way. `atOf` defaults to `0` ONLY when no time-sensitive brick is
      // configured (construction throws otherwise), where retry backoff reads
      // its time off the result/timer Msgs and the cold `at` is never compared.
      const at = atOf(msg as M);
      for (const cmd of baseCmds) {
        if (cmd.type !== target) {
          outCmds.push(cmd);
          continue;
        }
        const callKey = keyOf(cmd);
        const [nextSlice, runCmds] = rc.attempt(resilience, callKey, cmd, at);
        resilience = nextSlice;
        // rc.attempt emits 0 or 1 `resilient_run` carriers. Rename each to the
        // `$resilience:run` namespace, preserving the retagged `input` (the
        // ORIGINAL base Cmd). Zero carriers = the gate recorded a divergence in
        // `nextSlice` (cache/circuit/backoff) — visible in the slice + log.
        for (const rcRun of runCmds) {
          outCmds.push({
            type: "$resilience:run",
            key: rcRun.key,
            input: rcRun.input,
          });
        }
      }

      const next: WM = { base: nextBase, $resilience: resilience };
      return [next, outCmds];
    };
  }

  // --- `$resilience:ok` → succeed ------------------------------------------
  update["$resilience:ok"] = (state, msg) => {
    const m = msg as ResilienceOkMsg;
    const [slice, runCmds] = rc.succeed(state.$resilience, m.key, {
      type: MsgType.ResilientOk,
      key: m.key,
      result: m.result,
      at: m.at,
    });
    return [{ ...state, $resilience: slice }, renameRunCmds(runCmds)];
  };

  // --- `$resilience:err` → fail --------------------------------------------
  update["$resilience:err"] = (state, msg) => {
    const m = msg as ResilienceErrMsg;
    const [slice, runCmds] = rc.fail(state.$resilience, m.key, {
      type: MsgType.ResilientErr,
      key: m.key,
      error: m.error,
      at: m.at,
    });
    return [{ ...state, $resilience: slice }, renameRunCmds(runCmds)];
  };

  // --- `$resilience:timer` → onTimer (retry re-runs gate / deadline settles) -
  update["$resilience:timer"] = (state, msg) => {
    const m = msg as ResilienceTimerMsg;
    // Re-key the public `$resilience:`-id back to the resilient-call internal
    // id the `onTimer` verb matches against, then run the unmodified verb.
    const [slice, runCmds] = rc.onTimer(state.$resilience, {
      type: "deadline_exceeded",
      id: toRcTimerId(m.id),
      atMs: m.atMs,
    });
    return [{ ...state, $resilience: slice }, renameRunCmds(runCmds)];
  };

  // Rename any `resilient_run` carriers a verb produced (the retry re-attempt
  // path) into the `$resilience:run` namespace, preserving the retagged input.
  function renameRunCmds(
    runCmds: readonly { type: string; key: string; input: C }[],
  ): readonly WCmd[] {
    return runCmds.map((r) => ({
      type: "$resilience:run" as const,
      key: r.key,
      input: r.input,
    }));
  }

  // -------------------------------------------------------------------------
  // Subs — base subs ⧺ resilient-call timers, re-keyed into `$resilience:`.
  // -------------------------------------------------------------------------

  const baseSubscriptions = base.subscriptions;
  const baseSubscribe = (base as { subscribe?: unknown }).subscribe;

  function subscriptions(state: WM): readonly (U | ResilienceTimerSub)[] {
    const baseSubs = baseSubscriptions
      ? baseSubscriptions(state.base)
      : ([] as readonly U[]);
    // rc.subs returns DeadlineSubs keyed `resilient:retry:{k}` /
    // `resilient:deadline:{k}`. Re-key each into the `$resilience:` namespace
    // and re-type to the wrapper's `$resilience:timer` Sub family (rule 4).
    const rcSubs: readonly DeadlineSub[] = rc.subs(state.$resilience);
    const timerSubs: ResilienceTimerSub[] = rcSubs.map((s) => ({
      id: subId(toWrapperTimerId(s.id)),
      type: "$resilience:timer",
      atMs: s.atMs,
    }));
    return [...baseSubs, ...timerSubs];
  }

  // -------------------------------------------------------------------------
  // Interpret — base.interpret for non-target + the `$resilience:run` handler
  // that COMPOSES base.interpret for the retagged inner Cmd.
  // -------------------------------------------------------------------------

  const baseInterpret =
    (base as { interpret?: Interpret<M, C, Ctx> }).interpret ??
    ({} as Interpret<M, C, Ctx>);

  // Reserved-namespace guard (mirrors withTelemetry + the substrate's
  // definePort / SubId collision asserts). The wrapper OWNS four reserved keys:
  // the `$resilience:run` carrier Cmd, the `$resilience:ok` / `$resilience:err`
  // result Msgs, and the `$resilience:timer` Sub Msg. The merges below spread
  // the wrapper's cells over the base's update / interpret / subscribe maps; if
  // the base already declares ANY reserved key on ANY of those three surfaces,
  // the spread would SILENTLY clobber it (or the base's own key would shadow the
  // wrapper's). The `$resilience:` namespace is the wrapper's — refuse to wrap a
  // base that squats on any of the four across any surface.
  //
  // `update` is checked PER FORM (the same Reducer-vs-Transitions detection the
  // wrapper already uses in `baseMsgKeys` / `runBaseUpdate`): a Reducer-form
  // base keys its msg-types at the TOP level, but a Transitions-form base keys
  // them in the INNER `{ [stateType]: { [msgType]: cell } }` tables — so a flat
  // top-level `Object.hasOwn` would MISS a reserved msg-type squatting inside an
  // inner table (e.g. an inner `$resilience:ok` cell) and let the merged update
  // silently clobber it. `interpret` and `subscribe` are always flat keyed-by
  // -type maps, so the direct `Object.hasOwn` is correct there.
  const RESERVED = [
    "$resilience:run",
    "$resilience:ok",
    "$resilience:err",
    "$resilience:timer",
  ] as const;
  const surfaces: readonly {
    readonly name: string;
    readonly declares: (reserved: string) => boolean;
  }[] = [
    {
      name: "update",
      declares: (reserved) =>
        updateDeclaresMsgKey(base.update as object, reserved),
    },
    {
      name: "interpret",
      declares: (reserved) => Object.hasOwn(baseInterpret as object, reserved),
    },
    {
      name: "subscribe",
      declares: (reserved) =>
        Object.hasOwn((baseSubscribe as object | undefined) ?? {}, reserved),
    },
  ];
  for (const reserved of RESERVED) {
    for (const surface of surfaces) {
      if (surface.declares(reserved)) {
        throw new Error(
          `withResilience: the base machine declares a reserved "${reserved}" ` +
            `${surface.name} key — the wrapper owns the "$resilience:" ` +
            `namespace ($resilience:run / :ok / :err / :timer across update, ` +
            `interpret, and subscribe). Rename the base key.`,
        );
      }
    }
  }

  // The `$resilience:run` handler delegates to the BASE interpret handler for
  // the retagged inner Cmd's type, wrapped via tryInterpret so Ok routes to
  // `$resilience:ok` and Err to `$resilience:err`. `Date.now()` is stamped here
  // — the ONE permitted clock read (interpret is impure; update is pure).
  const runHandler = tryInterpret<
    ResilienceRunCmd<C>,
    // The carried result is the base interpret handler's resolution, whose
    // contract is `Promise<M | void>` (a follow-up base Msg or nothing — see
    // `Interpret<M, C, Ctx>`). Carrying `M | void` here (not bare `unknown`)
    // keeps the base's follow-up Msg type at the seam; `ResilienceOkMsg.result`
    // then narrows from genuine looseness to "a base Msg or void".
    // biome-ignore lint/suspicious/noConfusingVoidType: mirrors `Interpret`'s own `Promise<M | void>` — the base handler resolves to a follow-up Msg OR nothing; `M | undefined` would reject no-return bodies
    M | void,
    ResilienceOkMsg | ResilienceErrMsg,
    unknown
  >(
    async (cmd, ctx) => {
      // Compose the base interpret: run the ORIGINAL base Cmd through the base's
      // own handler for its type. The base handler may itself return a follow-up
      // Msg or void; the resilience layer treats its RESOLUTION (resolve vs
      // throw) as the success/failure signal, and carries whatever it returned
      // as `result`. A throw → tryInterpret routes to `$resilience:err`.
      const inner = cmd.input;
      // The base handler's own type is `Interpret<M, C, Ctx>[type]`, i.e.
      // `(cmd, ctx & PortEmitter) => Promise<M | void>`. We read it off the
      // erased `Record` and re-narrow to that contract — the result type is
      // KNOWN (the base Msg union or void), so it is not widened to `unknown`.
      // biome-ignore lint/suspicious/noConfusingVoidType: the base handler contract is `Promise<M | void>` (follow-up Msg or no-return); narrowing to `undefined` would reject void-returning base handlers
      type BaseHandler = (c: C, ctx: Ctx) => Promise<M | void>;
      const handler = (baseInterpret as Record<string, unknown>)[inner.type] as
        | BaseHandler
        | undefined;
      if (handler === undefined) {
        // The target Cmd has no base interpret handler — a miswired base. Surface
        // it as a resilience failure (routes to `fail`) rather than silently
        // succeeding: errors are data, never swallowed.
        throw new Error(
          `withResilience: no base interpret handler for target Cmd ` +
            `"${inner.type}" — the resilient effect has nothing to perform.`,
        );
      }
      return await handler(inner, ctx as unknown as Ctx);
    },
    (result, cmd): ResilienceOkMsg => ({
      type: "$resilience:ok",
      key: cmd.key,
      result,
      at: Date.now(),
    }),
    (error, cmd): ResilienceErrMsg => ({
      type: "$resilience:err",
      key: cmd.key,
      error,
      at: Date.now(),
    }),
  );

  const interpret = {
    ...(baseInterpret as Record<string, unknown>),
    "$resilience:run": runHandler,
  } as Interpret<WMsg, WCmd, Ctx>;

  // -------------------------------------------------------------------------
  // The `subscribe` map — base cells ⧺ the `$resilience:timer` cell, which
  // delegates the timer lifecycle to the deadline Sub primitive (re-keying the
  // dispatched Msg into the `$resilience:timer` shape). Clock lives here.
  // -------------------------------------------------------------------------

  const subscribeMap = {
    ...((baseSubscribe as Record<string, unknown> | undefined) ?? {}),
    "$resilience:timer": (
      sub: ResilienceTimerSub,
      ctx: Ctx,
      dispatch: (msg: WMsg) => void,
    ): (() => void) =>
      // Reuse the deadline subscribe cell wholesale: it arms a one-shot timer
      // for `max(0, atMs - Date.now())` and fires when the wall clock crosses
      // `atMs`. We hand it a `DeadlineSub` shape and translate its
      // `deadline_exceeded` Msg into the wrapper's `$resilience:timer` Msg.
      subscribeDeadline(
        { id: sub.id as DeadlineSub["id"], type: "deadline", atMs: sub.atMs },
        ctx,
        (dl) =>
          dispatch({ type: "$resilience:timer", id: dl.id, atMs: dl.atMs }),
      ),
  };

  return {
    init: (loaded, ctx) => {
      // Rehydrate: `loaded !== null` MUST return `[loaded, []]` (no Cmds) — the
      // substrate's replay enforces it. Split the composed loaded Model into its
      // base slice and feed the base its own snapshot so the base rehydrate
      // contract is honored transitively.
      if (loaded !== null) {
        return [loaded, []];
      }
      const [base0, baseCmds] = base.init(null, ctx);
      // The base's OWN init Cmds: NON-target Cmds pass straight through; a
      // TARGET Cmd is RETAGGED (admitted) so it is observed, never raw — the
      // same retag-not-swallow contract the merged update enforces (rule 2). A
      // target Cmd that escaped init raw would bypass the gate AND the carrier,
      // so the resilience layer would never see the effect resolve. At a fresh
      // boot the breaker is closed and the bucket full, so the gate decision is
      // unambiguously ADMIT — but the Cmd must still travel inside a
      // `$resilience:run` carrier (the slice records its `running` phase). Boot
      // is the resilience epoch: the cold gate runs at `at = 0`, harmless here
      // because the breaker is closed (nothing to compare), the cache empty, and
      // the bucket full. Wall time enters once the effect resolves (the
      // `$resilience:ok` / `:err` Msgs carry `at`), exactly as in a transition.
      let resilience = rc.init();
      const initCmds: WCmd[] = [];
      for (const cmd of baseCmds) {
        if (cmd.type !== target) {
          initCmds.push(cmd);
          continue;
        }
        // The boot cold attempt gates at `at = 0` (boot is the resilience epoch:
        // no real Msg drove it, so there is no time-as-data to read). For the
        // circuit / rateLimit / cache bricks that is harmless at a fresh boot —
        // the breaker is closed (nothing to compare), the bucket full, the cache
        // empty, so the gate ADMITS unambiguously and the `0` is never compared
        // against a real instant. The DEADLINE brick is the exception: it anchors
        // the cap at `at + deadline.ms = 0 + ms`, so its `$resilience:deadline`
        // Sub arms at `atMs = ms` and `subscribeDeadline` fires after
        // `max(0, atMs - Date.now()) === 0` ms — i.e. IMMEDIATELY at boot,
        // settling the boot call failed before it can run. A `0`-anchored boot
        // deadline is never the author's intent; it is the same trap the
        // construction guard refuses for transitions (a fabricated `at` the
        // deadline cannot honor). Fail loud: a boot effect that needs a real
        // deadline belongs behind a post-run boot Msg (where a real `at` exists),
        // not an init Cmd. Mirrors the substrate guidance "boot effects belong in
        // a boot Msg, not init Cmds."
        if (config.deadline !== undefined) {
          throw new Error(
            `withResilience: base.init emits the target Cmd "${target}" while a ` +
              `deadline brick is configured. The boot cold attempt has no real ` +
              `wall time (boot is gated at at=0), so the deadline would anchor at ` +
              `0 + ${config.deadline.ms}ms and its $resilience:deadline Sub would ` +
              `fire IMMEDIATELY (max(0, atMs - now) === 0), failing the boot call ` +
              `instantly. Move the boot effect out of base.init and into a boot ` +
              `Msg dispatched after run() (where the triggering Msg carries a real ` +
              `at via config.at), so the deadline anchors at a real instant. (Boot ` +
              `effects belong in a boot Msg, not init Cmds.)`,
          );
        }
        const callKey = keyOf(cmd);
        const [nextSlice, runCmds] = rc.attempt(resilience, callKey, cmd, 0);
        resilience = nextSlice;
        for (const rcRun of runCmds) {
          initCmds.push({
            type: "$resilience:run",
            key: rcRun.key,
            input: rcRun.input,
          });
        }
      }
      const model: WM = { base: base0, $resilience: resilience };
      return [model, initCmds];
    },
    update: update as unknown as Reducer<WM, WMsg, WCmd>,
    subscriptions,
    subscribe: subscribeMap as unknown as Machine<
      WM,
      WMsg,
      WCmd,
      U | ResilienceTimerSub,
      Ctx
    >["subscribe"],
    interpret,
  } as Machine<WM, WMsg, WCmd, U | ResilienceTimerSub, Ctx>;
}
