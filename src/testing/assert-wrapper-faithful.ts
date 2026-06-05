// ---------------------------------------------------------------------------
// `assertWrapperFaithful` — the shared conformance gate for the wrapper tier.
//
// A `withX` wrapper bolts a cross-cutting concern (telemetry, deadline,
// resilience) onto a base machine as an AUTHORING property — the base's source
// never hand-wires it. The DANGER is the runtime betrayal: hiding wrapper state
// in a closure, or silently swallowing / retiming a base Cmd, so the wrapper's
// behavior is invisible to the reducer + Msg log. This helper is the binary
// betrayal-detector every wrapper inherits. Pass = TEA-faithful, ship it.
// Fail = betrayal, does not merge.
//
// It asserts, by `replay` (which composes `init` + `update` only — the
// conformance path):
//
//   1. **Base behavior byte-identical.** `replay(wrapped).state.base` deep-
//      equals `replay(base).state`. The wrapper never alters base behavior.
//   2. **Slice AND wrapper Cmds reconstruct under any ambient clock/RNG.**
//      Replaying the SAME msgs under a DIFFERENT global wall-clock + RNG yields
//      a deep-equal wrapper slice AND a deep-equal `$x:*` wrapper-Cmd subset —
//      BOTH halves of the wrapper's output (state slice + emitted Cmds) are a
//      pure function of the Msg log, NOT of `Date.now()` / `Math.random()`.
//      (`update` cells never receive `ctx`, so an impure update read reaches for
//      the GLOBAL ambient; stubbing two distinct ambients and comparing catches
//      a folded wall-clock read that two back-to-back replays under one ambient
//      would hide.) The slice comparison alone has a blind spot: a clock/RNG
//      read folded into a wrapper Cmd PAYLOAD (not the slice) leaves the slice
//      identical, so we ALSO compare the `$x:*` Cmds across the two ambients.
//      Legit time enters only as Msg `at` payloads, identical across replays.
//   3. **Every wrapper decision is in the log.** At least one wrapper-tagged
//      Cmd (`$x:*`) or Msg appears in the replayed Cmd stream whenever there is
//      a transition — the wrapper's decisions are visible, not off-ledger.
//      PLUS a PER-TRANSITION check: at each step the bare machine's step-i Cmds
//      are an ordered subsequence of the wrapped machine's step-i Cmds, so a
//      base Cmd deferred to a LATER transition (intra-window retiming a
//      flattened subsequence would miss) surfaces as a step-level failure.
//   4. **Slice is JSON-round-trip equal.** `$x` survives
//      `JSON.parse(JSON.stringify(...))` — durable across DO eviction / reload,
//      never a closure.
//
// Strengthens invariant 9 (the testing surface is named and small) and is the
// mechanical CI form of the wrapper-tier conformance gate.
// ---------------------------------------------------------------------------

import { expect, vi } from "vitest";
import { type Cmd, type Machine, replay, type Sub } from "../index";

/**
 * The composed Model shape every `withX` wrapper produces: the base machine's
 * state nested under `base`, and the wrapper's own NAMED, serializable slice
 * under a single `$`-prefixed key. This helper does not care WHICH `$`-key the
 * wrapper uses — it discovers it structurally (the one non-`base` field).
 */
export type WrapperModel<S> = {
  readonly base: S;
} & { readonly [K: `$${string}`]: unknown };

/** Options for the conformance replay. Mirrors `replay`'s second argument. */
export interface AssertWrapperFaithfulOpts<S, WM, BaseM, BaseCtx, WrapperCtx> {
  /** The Msg sequence to fold through BOTH machines. Use the base's Msgs. */
  readonly msgs: readonly BaseM[];
  /** Ctx for the WRAPPED machine (base ctx + wrapper ports). */
  readonly ctx: WrapperCtx;
  /** Ctx for the BARE base machine. Defaults to `ctx` when omitted. */
  readonly baseCtx?: BaseCtx;
  /** Optional pre-`init` snapshot of the COMPOSED Model (wrapped rehydrate). */
  readonly loaded?: WM | null;
  /**
   * Optional pre-`init` snapshot of the BARE base state. Supply when the
   * wrapped `loaded` is non-null so the base-equivalence check rehydrates the
   * base machine from the matching nested slice. Defaults to `loaded?.base`.
   */
  readonly baseLoaded?: S | null;
  /**
   * Opt-in relaxation for an INTERCEPTING wrapper (e.g. `withResilience`).
   *
   * DEFAULT (`undefined` / `false`) — the OBSERVE-ONLY contract that
   * `withTelemetry` and `withDeadline` satisfy: every bare base Cmd must appear
   * UNCHANGED, in order, as a subsequence of the wrapped Cmd stream (properties
   * 1 and 3b). The wrapper may APPEND its own Cmds but may NOT alter, drop, or
   * retime a base Cmd. This is the strict default and it is NOT weakened.
   *
   * WHEN SET — for a wrapper whose whole job is to INTERCEPT a chosen base Cmd
   * (retag it into a wrapper-owned carrier so the concern — cache / breaker /
   * rate-limit / retry — can gate it), a target base Cmd LEGITIMATELY does not
   * appear raw at the top level of the wrapped stream. The contract is still
   * **retag-and-re-emit, never swallow** (rule 2): the Cmd must be RECORDED, not
   * vanished. So when a bare base Cmd is ABSENT from the top-level wrapped
   * subsequence, this option accepts it IFF, in that SAME transition window, it
   * is recorded by the wrapper as one of:
   *
   *   - the inner payload of a `$x:*` "run" carrier Cmd (`carrierCmdType` +
   *     `innerField`) — the retag path; OR
   *   - any other `$x:*` divergence Cmd whose `recordsField` deep-equals the
   *     base Cmd — the gate/defer path (e.g. a "fast-failed" or "deferred"
   *     record Cmd that carries the base Cmd it diverged on).
   *
   * A target base Cmd that is NEITHER present raw NOR recorded by any `$x:*`
   * Cmd in its window is a SWALLOW betrayal and still fails the gate.
   *
   * Provide the field names the carrier uses so the gate can unwrap it
   * structurally without hard-coding `withResilience`'s vocabulary.
   */
  readonly intercepting?: InterceptingOpt;
}

/**
 * Configures the intercepting relaxation (see
 * `AssertWrapperFaithfulOpts.intercepting`). All fields name the carrier /
 * divergence shape so the gate can structurally find a retagged base Cmd
 * inside a `$x:*` Cmd. The gate only EVER inspects `$x:*`-prefixed wrapped
 * Cmds for a recorded base Cmd — it never relaxes the check for a base Cmd
 * that appears under any non-wrapper Cmd type.
 */
export interface InterceptingOpt {
  /**
   * The `Cmd.type` of the wrapper's run-carrier (e.g. `"$resilience:run"`).
   * A bare base Cmd that is retagged appears as `carrier[innerField]`.
   */
  readonly carrierCmdType: string;
  /** The field on the carrier Cmd that holds the original base Cmd. */
  readonly innerField: string;
  /**
   * OPTIONAL field on ANY OTHER `$x:*` Cmd that records a base Cmd the wrapper
   * gated/deferred without running it (e.g. a fast-fail record). When present
   * on a `$x:*` Cmd and deep-equal to the missing base Cmd, it counts as a
   * recorded divergence. Omit when the wrapper only ever retags via the
   * carrier.
   */
  readonly recordsField?: string;
}

/**
 * Assert a `withX` wrapper is TEA-faithful. Replays the wrapped machine and the
 * bare base machine over the same Msgs and checks the four conformance
 * properties (see file header).
 *
 * @param base       the bare base `Machine`.
 * @param makeWrapped a thunk that wraps `base` and returns the composed machine
 *   (e.g. `() => withTelemetry(base, cfg)`). A thunk — not the wrapped value —
 *   so a wrapper that registers process-scoped ports (`definePort`) is
 *   constructed inside the assertion's control, and so the same betrayal-
 *   detector reads as `assertWrapperFaithful(base, () => withX(base, cfg), ...)`
 *   at every wrapper's test site.
 * @param opts       the conformance replay options.
 */
export function assertWrapperFaithful<
  S,
  BaseM extends { type: string },
  BaseC extends Cmd,
  BaseU extends Sub,
  BaseCtx,
  WM extends WrapperModel<S>,
  WrapperM extends { type: string },
  WrapperC extends Cmd,
  WrapperU extends Sub,
  WrapperCtx,
>(
  base: Machine<S, BaseM, BaseC, BaseU, BaseCtx>,
  makeWrapped: () => Machine<WM, WrapperM, WrapperC, WrapperU, WrapperCtx>,
  opts: AssertWrapperFaithfulOpts<S, WM, BaseM, BaseCtx, WrapperCtx>,
): void {
  const baseCtx = (opts.baseCtx ?? (opts.ctx as unknown as BaseCtx)) as BaseCtx;
  const wrappedMsgs = opts.msgs as unknown as readonly WrapperM[];
  const baseLoaded =
    opts.baseLoaded ?? (opts.loaded != null ? (opts.loaded.base as S) : null);

  // Two DISTINCT global ambients (wall-clock + RNG). `replay` composes only
  // `init` + `update`, and `update` cells are `(state, msg)` — they never
  // receive `ctx`. So an impure update read reaches for the GLOBAL `Date.now()`
  // / `Math.random()`, not an injected clock. Running the two determinism
  // replays under DIFFERENT ambients turns a folded wall-clock read into an
  // OBSERVABLE slice divergence (property 2) — a single fixed ambient (two
  // back-to-back replays) would return the same ms both times and hide it.
  const A0 = { now: 1_000_000, rng: 0.123 };
  const A1 = { now: 9_876_543, rng: 0.987 };

  // The bare baseline, `wrappedA`, and every per-transition baseline (props 3/4)
  // run under the SAME fixed ambient A0 so their cmds/state are deterministic.
  const bare = underAmbient(A0, () =>
    replay(base, { msgs: opts.msgs, ctx: baseCtx, loaded: baseLoaded }),
  );
  const wrapped = underAmbient(A0, () => makeWrapped());
  const wrappedA = underAmbient(A0, () =>
    replay(wrapped, {
      msgs: wrappedMsgs,
      ctx: opts.ctx,
      loaded: opts.loaded ?? null,
    }),
  );
  // The second determinism replay runs under a DISTINCT ambient A1. A faithful
  // wrapper's slice (a pure function of the Msg log) is identical under A0 and
  // A1; an impure update that folds `Date.now()` / `Math.random()` diverges.
  const wrappedB = underAmbient(A1, () =>
    replay(makeWrapped(), {
      msgs: wrappedMsgs,
      ctx: opts.ctx,
      loaded: opts.loaded ?? null,
    }),
  );

  // --- Property 1: base behavior byte-identical -----------------------------
  // `state.base` after wrapping === state after running the base alone. The
  // wrapper observes; it does not alter base behavior.
  expect(wrappedA.state.base).toEqual(bare.state);
  // The base's OWN Cmds appear in the wrapped Cmd stream unchanged: every bare
  // Cmd is present, in order, among the wrapped Cmds (with wrapper Cmds
  // interleaved). We assert the bare Cmds are a subsequence of the wrapped ones.
  // For an INTERCEPTING wrapper (`opts.intercepting` set) a target base Cmd is
  // accepted when it appears RETAGGED inside a `$x:*` carrier / recorded by a
  // `$x:*` divergence Cmd instead of raw — retag, not swallow.
  expectCmdSubsequence(bare.cmds, wrappedA.cmds, undefined, opts.intercepting);

  // --- Property 2: slice reconstructs under any ambient clock/RNG -----------
  // Replaying the same Msgs under a DIFFERENT global ambient yields a deep-equal
  // wrapper SLICE — the slice is a pure function of the Msg log, never of
  // `Date.now()` / `Math.random()`. We compare the single `$`-slice (not the
  // whole composed state) because comparing whole state would FALSE-POSITIVE
  // when the BASE machine reads the clock — that is the base's behavior, not the
  // wrapper's fault, and the wrapper's faithfulness is precisely what its own
  // slice records.
  const sliceKey = wrapperSliceKey(wrappedA.state);
  expect(
    sliceOf(wrappedB.state, sliceKey),
    `wrapper slice changed under a different ambient clock/RNG → update is ` +
      `reading Date.now()/Math.random(); time must enter only as Msg \`at\` data`,
  ).toEqual(sliceOf(wrappedA.state, sliceKey));

  // ...AND the wrapper-tagged Cmds reconstruct under any ambient too. The slice
  // is only HALF the wrapper's output — the other half is its emitted Cmds. A
  // wall-clock / RNG read folded into a wrapper Cmd PAYLOAD (not the state
  // slice) escapes the slice comparison above: the slice stays identical while
  // the Cmd carries a leaked `Date.now()` / `Math.random()`. So mirror the
  // slice check on the `$x:*` subset of the replayed Cmd stream — a faithful
  // wrapper emits Cmds that are a pure function of the Msg log, identical under
  // A0 and A1. Only Msg `at` payloads (identical across both replays) may carry
  // time; if a wrapper Cmd diverges between ambients, the wrapper read the
  // ambient clock/RNG into a Cmd. (Base Cmds are EXCLUDED — a base machine that
  // reads the clock is the base's behavior, not the wrapper's, exactly as the
  // slice comparison excludes whole-state.)
  const wrapperFamily = `${sliceKey}:`;
  const wrapperCmdsA = wrappedA.cmds.filter((c) =>
    c.type.startsWith(wrapperFamily),
  );
  const wrapperCmdsB = wrappedB.cmds.filter((c) =>
    c.type.startsWith(wrapperFamily),
  );
  expect(
    wrapperCmdsB,
    `wrapper Cmds ("${wrapperFamily}*") changed under a different ambient ` +
      `clock/RNG → a wrapper Cmd PAYLOAD is reading Date.now()/Math.random(); ` +
      `wrapper Cmds must be a pure function of the Msg log, time entering only ` +
      `as Msg \`at\` data`,
  ).toEqual(wrapperCmdsA);

  // --- Property 3: every wrapper decision appears as an XMsg/XCmd in the log -
  // The composed Model's wrapper slice is the single non-`base` `$`-key. We
  // discover its key family (`$telemetry` → `$telemetry:*`) and require that,
  // whenever there is at least one transition, the replayed Cmd stream carries
  // at least one wrapper-tagged Cmd. (Wrappers whose decisions are Msgs route
  // them through the SAME log; for a Cmd-emitting wrapper like withTelemetry the
  // decision is the `$x:emit` Cmd.) A wrapper that performed its work off-ledger
  // would have an EMPTY wrapper-Cmd set here despite real transitions — the
  // exact betrayal this gate exists to catch.
  if (opts.msgs.length > 0) {
    expect(
      wrapperCmdsA.length,
      `expected at least one "${wrapperFamily}*" wrapper-decision Cmd in the replay log ` +
        `(found none across ${opts.msgs.length} transition(s)) — a wrapper whose ` +
        `decisions are invisible to the Msg/Cmd log has betrayed total visibility`,
    ).toBeGreaterThan(0);
  }

  // --- Property 3b: per-transition Cmd subsequence --------------------------
  // The flattened subsequence (property 1) misses INTRA-WINDOW retiming — a
  // base Cmd that a saga-style wrapper DEFERS to a later transition still drains
  // within the replay, so the flattened bare-Cmd set stays an ordered
  // subsequence and slips through. Pin it per step: for each transition i, the
  // bare machine's step-i Cmds must be an ordered subsequence of the wrapped
  // machine's step-i Cmds. A deferred base Cmd is then visible as a step-i
  // subsequence failure (it shows up at i+1 in the wrapped run but at i in the
  // bare run). Prefix replays run under the fixed ambient A0 for determinism.
  for (let i = 0; i < opts.msgs.length; i++) {
    const bareStep = stepCmds(
      () =>
        underAmbient(A0, () =>
          replay(base, {
            msgs: opts.msgs.slice(0, i),
            ctx: baseCtx,
            loaded: baseLoaded,
          }),
        ).cmds,
      () =>
        underAmbient(A0, () =>
          replay(base, {
            msgs: opts.msgs.slice(0, i + 1),
            ctx: baseCtx,
            loaded: baseLoaded,
          }),
        ).cmds,
    );
    const wrappedStep = stepCmds(
      () =>
        underAmbient(A0, () =>
          replay(wrapped, {
            msgs: wrappedMsgs.slice(0, i),
            ctx: opts.ctx,
            loaded: opts.loaded ?? null,
          }),
        ).cmds,
      () =>
        underAmbient(A0, () =>
          replay(wrapped, {
            msgs: wrappedMsgs.slice(0, i + 1),
            ctx: opts.ctx,
            loaded: opts.loaded ?? null,
          }),
        ).cmds,
    );
    expectCmdSubsequence(bareStep, wrappedStep, i, opts.intercepting);
  }

  // --- Property 4: slice is JSON-round-trip equal ---------------------------
  // The wrapper slice survives JSON.parse(JSON.stringify(...)) — durable across
  // DO eviction / reload, never a closure.
  const slice = sliceOf(wrappedA.state, sliceKey);
  expect(JSON.parse(JSON.stringify(slice))).toEqual(slice);
}

/**
 * Run `fn` with the GLOBAL `Date.now` and `Math.random` stubbed to fixed
 * values, restoring them in a `finally` so the stub never leaks across
 * assertions or tests. `update` cells receive no `ctx`, so an impure read
 * inside one resolves to these globals — the lever this gate pulls to make a
 * folded wall-clock / RNG read observable in the wrapper slice.
 */
function underAmbient<T>(
  ambient: { readonly now: number; readonly rng: number },
  fn: () => T,
): T {
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(ambient.now);
  const rngSpy = vi.spyOn(Math, "random").mockReturnValue(ambient.rng);
  try {
    return fn();
  } finally {
    nowSpy.mockRestore();
    rngSpy.mockRestore();
  }
}

/** The wrapper slice value (the single `$`-key) on a composed Model. */
function sliceOf(model: object, sliceKey: string): unknown {
  return (model as Record<string, unknown>)[sliceKey];
}

/**
 * The Cmds a single transition `i` emitted: the suffix of the cmds after
 * `msgs.slice(0, i+1)` past the cmds after `msgs.slice(0, i)`. Cmds accumulate
 * in order across `replay`, so the longer run is a prefix-extension of the
 * shorter one and the suffix is exactly step `i`'s contribution.
 */
function stepCmds(
  prefixCmds: () => readonly Cmd[],
  throughCmds: () => readonly Cmd[],
): readonly Cmd[] {
  const before = prefixCmds();
  const after = throughCmds();
  return after.slice(before.length);
}

/**
 * The wrapper slice key on a composed Model — the single own enumerable field
 * whose name starts with `$`. Throws if zero or more than one is found, because
 * the wrapper-tier contract is exactly one named `$`-slice per wrapper.
 */
function wrapperSliceKey(model: object): string {
  const dollarKeys = Object.keys(model).filter((k) => k.startsWith("$"));
  if (dollarKeys.length !== 1) {
    throw new Error(
      `assertWrapperFaithful: expected exactly one "$"-prefixed wrapper slice ` +
        `on the composed Model, found ${dollarKeys.length} (${dollarKeys.join(", ") || "none"}). ` +
        `Every withX wrapper owns exactly one named slice (e.g. "$telemetry").`,
    );
  }
  // biome-ignore lint/style/noNonNullAssertion: length checked to be exactly 1 above
  return dollarKeys[0]!;
}

/**
 * Assert `needle` is an (order-preserving) subsequence of `haystack` by deep
 * equality — every base Cmd appears, in order, somewhere in the wrapped Cmd
 * stream (wrapper Cmds may be interleaved). This is the "base Cmds pass through
 * UNCHANGED" check that tolerates the wrapper's own appended Cmds without
 * requiring an exact-equal stream. When `step` is supplied the message names
 * the transition index, so a per-transition retiming failure points at the
 * exact step a base Cmd was deferred away from.
 *
 * `intercepting` (default `undefined` → the strict OBSERVE-ONLY check above)
 * relaxes the match for a base Cmd that an INTERCEPTING wrapper retags: when a
 * needle Cmd is NOT found raw in `haystack`, it is accepted IFF some `$x:*`
 * wrapper Cmd in `haystack` RECORDS it — as the carrier's `innerField` payload
 * (retag) or another `$x:*` Cmd's `recordsField` (recorded gate/defer). The
 * relaxation ONLY ever looks inside `$x:*` Cmds, so a base Cmd that vanished
 * with no `$x:*` record still fails. The order check is preserved: the carrier
 * / divergence Cmd must come at or after the cursor, exactly like a raw match.
 */
function expectCmdSubsequence(
  needle: readonly Cmd[],
  haystack: readonly Cmd[],
  step?: number,
  intercepting?: InterceptingOpt,
): void {
  let i = 0;
  for (const cmd of haystack) {
    if (i >= needle.length) break;
    if (__deepEqual(needle[i], cmd)) {
      i++;
      continue;
    }
    // Intercepting relaxation: the base Cmd at the cursor may legitimately be
    // absent raw because the wrapper RETAGGED it. Accept this haystack Cmd as
    // the matching slot IFF it is a `$x:*` wrapper Cmd that records `needle[i]`.
    if (
      intercepting !== undefined &&
      recordsBaseCmd(cmd, needle[i] as Cmd, intercepting)
    ) {
      i++;
    }
  }
  const where =
    step === undefined
      ? "the wrapped Cmd stream"
      : `the wrapped Cmd stream AT TRANSITION ${step} (a base Cmd deferred to a ` +
        `later transition is an intra-window retiming betrayal)`;
  const swallowHint =
    intercepting === undefined
      ? "a missing/rewritten/retimed base Cmd is a swallow betrayal"
      : `an intercepting wrapper must RETAG each target base Cmd into a ` +
        `"${intercepting.carrierCmdType}" carrier (inner field ` +
        `"${intercepting.innerField}") or record it on a "$*:" divergence Cmd ` +
        `— a base Cmd neither present raw NOR recorded by any "$*:" Cmd is a ` +
        `swallow betrayal`;
  expect(
    i,
    `expected every base Cmd to pass through unchanged (matched ${i} of ` +
      `${needle.length} base Cmds as an ordered subsequence of ${where}) — ` +
      `${swallowHint}`,
  ).toBe(needle.length);
}

/**
 * Does the wrapped Cmd `cmd` RECORD the base Cmd `baseCmd` under the
 * intercepting contract? True iff `cmd` is a `$`-prefixed wrapper Cmd AND
 * either:
 *   - `cmd.type === carrierCmdType` and `cmd[innerField]` deep-equals
 *     `baseCmd` (the retag carrier), OR
 *   - `recordsField` is configured and `cmd[recordsField]` deep-equals
 *     `baseCmd` (a recorded gate/defer divergence on any `$x:*` Cmd).
 *
 * The `$`-prefix guard is load-bearing: the relaxation must NEVER accept a base
 * Cmd hidden inside a NON-wrapper Cmd — that would let a wrapper launder a
 * swallowed base Cmd through an arbitrary re-emit. Only the wrapper's own
 * `$x:*` family may carry a retagged base Cmd.
 */
function recordsBaseCmd(cmd: Cmd, baseCmd: Cmd, opt: InterceptingOpt): boolean {
  if (!cmd.type.startsWith("$")) return false;
  const rec = cmd as unknown as Record<string, unknown>;
  if (
    cmd.type === opt.carrierCmdType &&
    __deepEqual(rec[opt.innerField], baseCmd)
  )
    return true;
  if (
    opt.recordsField !== undefined &&
    __deepEqual(rec[opt.recordsField], baseCmd)
  )
    return true;
  return false;
}

/**
 * Structural deep equality for plain Cmd data.
 *
 * NOT `JSON.stringify` equality: `JSON.stringify` DROPS undefined-valued fields,
 * so `{ type: "x" }` would falsely equal `{ type: "x", foo: undefined }` and the
 * gate could accept a wrapper that smuggles an extra (undefined) field into a
 * "byte-identical" base Cmd or a retag carrier. This walk distinguishes an
 * ABSENT key from an `undefined`-VALUED key by comparing the full own-enumerable
 * key SET (not just the defined values) in both directions, then recursing.
 *
 * Cmds are plain data — primitives, `null`, arrays, and plain objects — so this
 * intentionally does not model `Date`, `Map`, `Set`, cycles, or class instances.
 *
 * Exported under the `__` test-only convention so the conformance suite can
 * pin the absent-vs-undefined distinction directly. Not part of the public API.
 *
 * @internal test-only
 */
export function __deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  // Past the identity check, equality requires same kind on both sides. Anything
  // non-object (primitive, function, symbol) that wasn't `Object.is`-equal above
  // is unequal. `null` is `typeof "object"` but only equals `null` (caught by
  // `Object.is`), so screen it out explicitly.
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;

  if (aIsArray) {
    const bArr = b as unknown[];
    if (a.length !== bArr.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!__deepEqual(a[i], bArr[i])) return false;
    }
    return true;
  }

  // Plain objects: compare the own-enumerable key SET first so a key present on
  // one side with an `undefined` value (and absent on the other) is caught —
  // the betrayal `JSON.stringify` hid. Then recurse on every value.
  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec);
  const bKeys = Object.keys(bRec);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(bRec, key)) return false;
    if (!__deepEqual(aRec[key], bRec[key])) return false;
  }
  return true;
}
