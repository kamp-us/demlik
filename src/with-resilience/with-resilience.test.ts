import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Cmd, defineMachine, replay, run, type subId } from "../index";
import { assertWrapperFaithful } from "../testing";
import { type ResilienceRunCmd, withResilience } from "./index";

// ===========================================================================
// A base machine with TWO effect Cmds: `do_fetch` (the resilience TARGET) and
// `log` (a NON-target Cmd that must pass through untouched). The target lets us
// prove retag-not-swallow; the non-target proves the wrapper leaves other
// effects byte-identical.
// ===========================================================================

interface FetchState {
  readonly url: string | null;
  readonly body: string | null;
}

// `load` carries `at` — the REAL wall time the triggering Msg supplies as data
// (time-as-data). The wrapper's `config.at` reads it off this Msg to drive the
// cold-attempt gate, so the breaker / cache / deadline compare against true wall
// time instead of a fabricated `0`.
type FetchMsg =
  | { readonly type: "load"; readonly url: string; readonly at: number }
  | { readonly type: "loaded"; readonly body: string }
  | { readonly type: "note" };

// The wrapper config's `at` reader: the triggering base Msg's wall-time data.
// Only `load` (which emits the target `do_fetch`) carries `at`; the other Msgs
// never emit a target Cmd, so their cold gate is never run.
const atOf = (m: FetchMsg): number => (m.type === "load" ? m.at : 0);

// The TARGET Cmd — the base authors it plainly; the wrapper hardens it.
type DoFetchCmd = Cmd<"do_fetch"> & { readonly url: string };
// A NON-target Cmd — must survive wrapping byte-identical.
type LogCmd = Cmd<"log"> & { readonly line: string };
type FetchCmd = DoFetchCmd | LogCmd;

interface FetchCtx {
  // The fallible work the target Cmd performs. The wrapper composes the base
  // interpret, so a throw here becomes a `$resilience:err`.
  readonly fetchUrl: (url: string) => Promise<string>;
  // The non-target effect's side channel.
  readonly logLine: (line: string) => void;
}

function makeBase() {
  return defineMachine<FetchState, FetchMsg, FetchCmd, never, FetchCtx>({
    init: (loaded) => [loaded ?? { url: null, body: null }, []],
    update: {
      // `load` emits BOTH a non-target `log` Cmd AND the target `do_fetch` —
      // partition must keep `log` raw and retag `do_fetch`.
      load: (_s, m) => [
        { url: m.url, body: null },
        [
          { type: "log", line: `loading ${m.url}` },
          { type: "do_fetch", url: m.url },
        ],
      ],
      // `loaded` is the follow-up the base interpret would dispatch on success;
      // here it just records the body. Emits no Cmd.
      loaded: (s, m) => [{ ...s, body: m.body }, []],
      // `note` emits only the non-target Cmd — proves non-target is unaffected
      // even when no target Cmd is present in the transition.
      note: (s) => [s, [{ type: "log", line: "noted" }]],
    },
    interpret: {
      // The TARGET's base handler — the actual work the resilience layer wraps.
      do_fetch: async (cmd, ctx): Promise<FetchMsg> => {
        const body = await ctx.fetchUrl(cmd.url);
        return { type: "loaded", body };
      },
      // The NON-target handler — fire-and-forget; never touched by the wrapper.
      log: async (cmd, ctx) => {
        ctx.logLine(cmd.line);
      },
    },
  });
}

// ===========================================================================
// Conformance — the intercepting gate. The target `do_fetch` is RETAGGED into
// a `$resilience:run` inner payload (never raw), the non-target `log` passes
// through, and the slice reconstructs deterministically from the Msg log.
// ===========================================================================

describe("withResilience — intercepting conformance gate", () => {
  const ctx: FetchCtx = {
    fetchUrl: async () => "unused-in-replay",
    logLine: () => {},
  };

  it("is faithful: target retagged-not-swallowed, non-target untouched, slice reconstructs", () => {
    const base = makeBase();
    assertWrapperFaithful(
      base,
      () =>
        withResilience(
          base,
          {
            target: "do_fetch",
            at: atOf,
            retry: {
              baseMs: 100,
              factor: 2,
              capMs: 1000,
              maxAttempts: 5,
              jitter: "none",
            },
            circuit: { threshold: 2, cooldownMs: 50 },
          },
          () => 0.5,
        ),
      {
        // The wrapped machine's Msgs are the base Msgs UNION the wrapper Msgs;
        // the gate folds them through both machines (base ignores the wrapper
        // Msgs because they are absent from its update — but the gate only runs
        // the BARE base over `opts.msgs`, so we keep `msgs` to the base-shaped
        // subset for the bare run and pass the union as the wrapped run via the
        // intercepting contract). Here every msg the base understands (`load`,
        // `note`) is a base Msg; the `$resilience:ok` is a wrapper Msg the base
        // has no cell for — so we drive the gate with ONLY base-understood Msgs.
        msgs: [
          { type: "load", url: "/a", at: 1_000 },
          { type: "note" },
        ] as readonly FetchMsg[],
        ctx,
        intercepting: {
          carrierCmdType: "$resilience:run",
          innerField: "input",
        },
      },
    );
  });

  it("the target Cmd appears RETAGGED inside $resilience:run, never raw", () => {
    const base = makeBase();
    const wrapped = withResilience(
      base,
      {
        target: "do_fetch",
        at: atOf,
        circuit: { threshold: 2, cooldownMs: 50 },
      },
      () => 0.5,
    );
    const { cmds } = replay(wrapped, {
      msgs: [{ type: "load", url: "/x", at: 1_000 }],
      ctx,
    });
    // No raw `do_fetch` at the top level.
    expect(cmds.find((c) => c.type === "do_fetch")).toBeUndefined();
    // The non-target `log` passes through byte-identical.
    expect(cmds.find((c) => c.type === "log")).toEqual({
      type: "log",
      line: "loading /x",
    });
    // The target is the inner payload of the `$resilience:run` carrier.
    const run = cmds.find((c) => c.type === "$resilience:run") as
      | ResilienceRunCmd<FetchCmd>
      | undefined;
    expect(run).toBeDefined();
    expect(run?.input).toEqual({ type: "do_fetch", url: "/x" });
    expect(run?.key).toBe("do_fetch");
  });

  it("non-target-only transitions leave the base Cmd untouched and emit no carrier", () => {
    const base = makeBase();
    const wrapped = withResilience(base, { target: "do_fetch" }, () => 0.5);
    const { cmds } = replay(wrapped, { msgs: [{ type: "note" }], ctx });
    expect(cmds).toEqual([{ type: "log", line: "noted" }]);
  });

  it("a custom keyOf partitions resilience state per logical call", () => {
    const base = makeBase();
    const wrapped = withResilience(
      base,
      { target: "do_fetch", keyOf: (c) => (c as DoFetchCmd).url },
      () => 0.5,
    );
    const { cmds, state } = replay(wrapped, {
      msgs: [
        { type: "load", url: "/a", at: 1_000 },
        { type: "load", url: "/b", at: 2_000 },
      ],
      ctx,
    });
    const runs = cmds.filter(
      (c) => c.type === "$resilience:run",
    ) as ResilienceRunCmd<FetchCmd>[];
    expect(runs.map((r) => r.key)).toEqual(["/a", "/b"]);
    // Two independent call phases keyed by url.
    expect(Object.keys(state.$resilience.calls).sort()).toEqual(["/a", "/b"]);
  });
});

// ===========================================================================
// Reserved-namespace guard — a base that squats on `$resilience:run` is refused.
// ===========================================================================

describe("withResilience — reserved namespace guard", () => {
  it("throws if the base declares a reserved $resilience:run interpret key", () => {
    type SquatCmd = Cmd<"$resilience:run"> & { readonly note: string };
    const squatting = defineMachine<
      FetchState,
      FetchMsg,
      SquatCmd,
      never,
      FetchCtx
    >({
      init: (loaded) => [loaded ?? { url: null, body: null }, []],
      update: {
        load: (s) => [s, [{ type: "$resilience:run", note: "base-owned" }]],
        loaded: (s) => [s, []],
        note: (s) => [s, []],
      },
      interpret: {
        "$resilience:run": async () => {},
      },
    });
    expect(() =>
      withResilience(squatting as never, { target: "do_fetch" }),
    ).toThrow(/reserved "\$resilience:run" interpret key/);
  });

  // The guard covers ALL FOUR reserved keys ($resilience:run / :ok / :err /
  // :timer) across ALL THREE base surfaces (update / interpret / subscribe), not
  // just `$resilience:run` on interpret. A base that squats on any of the twelve
  // (key × surface) combinations is refused — the spread would otherwise silently
  // clobber the wrapper's cell (or the base's would shadow it).

  it("throws if the base declares a reserved $resilience:ok UPDATE key", () => {
    // The base reducer squats on `$resilience:ok` — the wrapper's `succeed`
    // cell would be silently shadowed.
    const squatting = defineMachine<
      FetchState,
      { readonly type: "$resilience:ok" } | FetchMsg,
      DoFetchCmd,
      never,
      FetchCtx
    >({
      init: (loaded) => [loaded ?? { url: null, body: null }, []],
      update: {
        "$resilience:ok": (s) => [s, []],
        load: (_s, m) => [
          { url: m.url, body: null },
          [{ type: "do_fetch", url: m.url }],
        ],
        loaded: (s) => [s, []],
        note: (s) => [s, []],
      },
      interpret: { do_fetch: async () => ({ type: "note" }) as FetchMsg },
    });
    expect(() =>
      withResilience(squatting as never, {
        target: "do_fetch",
        at: atOf,
        circuit: { threshold: 1, cooldownMs: 50 },
      }),
    ).toThrow(/reserved "\$resilience:ok" update key/);
  });

  it("throws if the base declares a reserved $resilience:err INTERPRET key", () => {
    type ErrCmd = Cmd<"$resilience:err"> & { readonly note: string };
    const squatting = defineMachine<
      FetchState,
      FetchMsg,
      ErrCmd,
      never,
      FetchCtx
    >({
      init: (loaded) => [loaded ?? { url: null, body: null }, []],
      update: {
        load: (s) => [s, []],
        loaded: (s) => [s, []],
        note: (s) => [s, []],
      },
      interpret: { "$resilience:err": async () => {} },
    });
    expect(() =>
      withResilience(squatting as never, { target: "do_fetch" }),
    ).toThrow(/reserved "\$resilience:err" interpret key/);
  });

  // FINDING #2 — the guard must check the CORRECT level per update form. A
  // Transitions-form base keys its msg-types in the INNER `{ stateType: {
  // msgType: cell } }` tables, so a reserved msg-type (e.g. `$resilience:ok`)
  // hides inside an inner table, NOT at the top level (which holds state-types).
  // A flat top-level `Object.hasOwn` would MISS it and let the merged update
  // silently clobber the base's inner `$resilience:ok` cell. The form-aware
  // guard scans every inner table and refuses the wrap.
  it("throws if a TRANSITIONS-form base declares an inner $resilience:ok cell", () => {
    // State is a discriminated union → the table form keys cells by state.type,
    // and EACH inner table keys by msg.type. The base squats on an inner
    // `$resilience:ok` cell (under the `idle` state) — invisible to a top-level
    // key scan, but a real collision with the wrapper's `succeed` cell.
    type TState =
      | { readonly type: "idle"; readonly url: string | null }
      | { readonly type: "loading"; readonly url: string };
    type TMsg =
      | { readonly type: "load"; readonly url: string; readonly at: number }
      | { readonly type: "loaded"; readonly body: string }
      | { readonly type: "note" }
      | { readonly type: "$resilience:ok" };

    const squatting = defineMachine<TState, TMsg, DoFetchCmd, never, FetchCtx>({
      init: (loaded) => [loaded ?? { type: "idle", url: null }, []],
      update: {
        idle: {
          load: (_s, m) => [
            { type: "loading", url: m.url },
            [{ type: "do_fetch", url: m.url }],
          ],
          loaded: (s) => [s, []],
          note: (s) => [s, []],
          // The squatted reserved cell lives DEEP in the table, not at top level.
          "$resilience:ok": (s) => [s, []],
        },
        loading: {
          load: (s) => [s, []],
          loaded: (s) => [{ type: "idle", url: s.url }, []],
          note: (s) => [s, []],
          "$resilience:ok": (s) => [s, []],
        },
      },
      interpret: { do_fetch: async () => ({ type: "note" }) as TMsg },
    });

    expect(() =>
      withResilience(squatting as never, {
        target: "do_fetch",
        at: ((m: TMsg) => (m.type === "load" ? m.at : 0)) as never,
        circuit: { threshold: 1, cooldownMs: 50 },
      }),
    ).toThrow(/reserved "\$resilience:ok" update key/);
  });

  it("throws if the base declares a reserved $resilience:timer SUBSCRIBE key", () => {
    type TimerSub = { id: ReturnType<typeof subId>; type: "$resilience:timer" };
    const squatting = defineMachine<
      FetchState,
      FetchMsg,
      DoFetchCmd,
      TimerSub,
      FetchCtx
    >({
      init: (loaded) => [loaded ?? { url: null, body: null }, []],
      update: {
        load: (s) => [s, []],
        loaded: (s) => [s, []],
        note: (s) => [s, []],
      },
      interpret: { do_fetch: async () => ({ type: "note" }) as FetchMsg },
      subscriptions: () => [],
      subscribe: {
        "$resilience:timer": () => () => {},
      },
    });
    expect(() =>
      withResilience(squatting as never, { target: "do_fetch" }),
    ).toThrow(/reserved "\$resilience:timer" subscribe key/);
  });
});

// ===========================================================================
// Construction guard — a time-sensitive brick without `config.at` is refused.
// The cold-attempt gate needs the REAL wall time the triggering base Msg carries
// (time-as-data); without it the gate fabricates `0` and the breaker can never
// recover. Errors are data: surfaced at construction, not as a silent dead
// breaker. Retry alone (which reads time off the result/timer Msgs) is exempt.
// ===========================================================================

describe("withResilience — construction guard: time-sensitive brick needs `at`", () => {
  it("throws when `circuit` is configured but `at` is omitted", () => {
    const base = makeBase();
    expect(() =>
      withResilience(base, {
        target: "do_fetch",
        circuit: { threshold: 1, cooldownMs: 50 },
      }),
    ).toThrow(/`config\.at` is missing/);
  });

  it("throws when `deadline` is configured but `at` is omitted", () => {
    const base = makeBase();
    expect(() =>
      withResilience(base, { target: "do_fetch", deadline: { ms: 5_000 } }),
    ).toThrow(/`config\.at` is missing/);
  });

  it("does NOT throw when only `retry` is configured (at is optional there)", () => {
    const base = makeBase();
    expect(() =>
      withResilience(base, {
        target: "do_fetch",
        retry: {
          baseMs: 100,
          factor: 2,
          capMs: 1000,
          maxAttempts: 5,
          jitter: "none",
        },
      }),
    ).not.toThrow();
  });
});

// ===========================================================================
// Real run() — fail → retry-timer → succeed END TO END. The target Cmd is
// actually performed via the composed base.interpret; the breaker opens on the
// failure, then recovers (half-open probe succeeds → closed) on the retry, and
// the retry counter resets on success.
// ===========================================================================

describe("withResilience — real runtime: fail, retry-timer, succeed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const BASE = 1_000_000;

  it("performs the target via base.interpret, opens then recovers the breaker, resets retry", async () => {
    vi.setSystemTime(BASE);

    // The port fails the FIRST attempt, succeeds the SECOND. The wrapper drives
    // the retry between them — the base never knows it was retried.
    let attempts = 0;
    const logged: string[] = [];
    const ctx: FetchCtx = {
      fetchUrl: async (url: string) => {
        attempts += 1;
        if (attempts === 1) throw new Error(`transient failure for ${url}`);
        return `BODY(${url})`;
      },
      logLine: (line) => logged.push(line),
    };

    const base = makeBase();
    const wrapped = withResilience(
      base,
      {
        target: "do_fetch",
        // The triggering Msg's wall time drives the cold-attempt gate.
        at: atOf,
        // threshold 1 → the single failure OPENS the breaker, so the retry must
        // pass the half-open probe to recover (full breaker round trip).
        circuit: { threshold: 1, cooldownMs: 50 },
        // baseMs 100 × factor^1 = 200ms backoff for the first retry (attempt
        // index 1), no jitter → deterministic retryAtMs; cooldown (50) < delay
        // (200) so the breaker has cooled by the time the retry timer fires.
        retry: {
          baseMs: 100,
          factor: 2,
          capMs: 1000,
          maxAttempts: 5,
          jitter: "none",
        },
      },
      () => 0.5,
    );

    const runtime = run(wrapped, { ctx });
    await runtime.ready;

    // Drive the first attempt. The base emits `log` (fires immediately) + the
    // target `do_fetch` (retagged → run → base interpret throws → $resilience:err).
    await runtime.dispatch({ type: "load", url: "/x", at: BASE });
    // Let the err Msg + fail verb settle on the tail.
    await vi.advanceTimersByTimeAsync(0);

    const afterFail = runtime.getState();
    // The non-target effect ran untouched.
    expect(logged).toEqual(["loading /x"]);
    // The breaker OPENED on the failure (threshold 1).
    expect(afterFail.$resilience.circuit.phase).toBe("open");
    // The call is waiting on its retry timer (not yet given up).
    expect(afterFail.$resilience.calls.do_fetch?.phase).toBe("waiting_retry");
    // The retry run advanced exactly one attempt; the port was hit once.
    expect(attempts).toBe(1);

    // Cross the 200ms backoff: the retry timer fires → onTimer re-gates → the
    // breaker is open but cooled (elapsed 200 ≥ cooldown 50) → half-open probe
    // admitted → $resilience:run → base interpret SUCCEEDS this time.
    await vi.advanceTimersByTimeAsync(200);
    // Drain the ok Msg + succeed verb.
    await vi.advanceTimersByTimeAsync(0);

    const afterSucceed = runtime.getState();
    // The target was actually performed via the composed base.interpret twice
    // (one failure, one success) — the wrapper did not fabricate the result.
    expect(attempts).toBe(2);
    // The breaker RECOVERED: half-open probe succeeded → closed.
    expect(afterSucceed.$resilience.circuit).toEqual({
      phase: "closed",
      failures: 0,
    });
    // The call settled succeeded, carrying the base interpret's result (the
    // follow-up Msg the base handler returned, opaque to the wrapper).
    expect(afterSucceed.$resilience.calls.do_fetch).toEqual({
      phase: "succeeded",
      result: { type: "loaded", body: "BODY(/x)" },
    });
    // The retry counter RESET on success — no stale backoff state for this key.
    expect(afterSucceed.$resilience.retry.do_fetch).toBeUndefined();

    await runtime.stop();
  });
});

// ===========================================================================
// Breaker RECOVERY proof (CRITICAL + HIGH regression). The cold-attempt gate
// reads the REAL wall time off the triggering base Msg (`config.at`), NOT a
// fabricated `0`. So:
//
//   - trip the breaker at a real time T,
//   - a cold attempt DURING cooldown (T + small) is fast-failed (circuit_open),
//   - a cold attempt AFTER cooldown (T + > cooldown, real `at`) is ADMITTED
//     (half-open probe → $resilience:run) and SUCCEEDS → breaker closes.
//
// With the old `at = 0` bug the post-cooldown cold attempt computed
// `elapsed = 0 - T < 0 < cooldown` forever, so the breaker NEVER recovered.
// This is a pure `replay` proof — `at` is Msg data, no fake clock.
// ===========================================================================

describe("withResilience — breaker recovers after a real-time trip + cooldown", () => {
  const ctx: FetchCtx = { fetchUrl: async () => "x", logLine: () => {} };
  const T = 5_000_000; // the real wall time the breaker trips at.
  const COOLDOWN = 50;

  function makeWrapped() {
    const base = makeBase();
    return withResilience(
      base,
      {
        target: "do_fetch",
        at: atOf, // the cold gate reads the triggering Msg's real wall time.
        // threshold 1 → one failure trips the breaker open at T.
        // NO retry brick → the failure is terminal (the call settles failed and
        // the breaker stays cleanly open), so the ONLY way back to a target run
        // is a fresh cold attempt after cooldown — exactly what we are proving.
        circuit: { threshold: 1, cooldownMs: COOLDOWN },
      },
      () => 0.5,
    );
  }

  it("fast-fails a cold attempt during cooldown, admits one after cooldown", () => {
    const wrapped = makeWrapped();

    // 1) Cold attempt at T → breaker closed → admitted → carrier emitted.
    // 2) The effect FAILS at T → fail → breaker trips open(openedAtMs = T).
    // 3) Cold attempt at T+10 (< cooldown 50) → breaker open, still cooling →
    //    fast-fail: phase `circuit_open`, NO new carrier.
    // 4) Cold attempt at T+100 (≥ cooldown) → breaker open but cooled → half-open
    //    probe ADMITTED → new carrier emitted.
    // 5) The probe SUCCEEDS at T+100 → succeed → breaker closes.
    const { state, cmds } = replay(wrapped, {
      msgs: [
        { type: "load", url: "/x", at: T },
        { type: "$resilience:err", key: "do_fetch", error: "boom", at: T },
        { type: "load", url: "/x", at: T + 10 },
        { type: "load", url: "/x", at: T + 100 },
        {
          type: "$resilience:ok",
          key: "do_fetch",
          result: { type: "loaded", body: "OK" },
          at: T + 100,
        },
      ] as readonly FetchMsg[],
      ctx,
    });

    const carriers = cmds.filter((c) => c.type === "$resilience:run");
    // EXACTLY two carriers: the initial cold admit (step 1) and the post-cooldown
    // recovery admit (step 4). The during-cooldown attempt (step 3) emitted none.
    expect(carriers.length).toBe(2);

    // The breaker RECOVERED — the post-cooldown probe succeeded → closed.
    expect(state.$resilience.circuit).toEqual({ phase: "closed", failures: 0 });
    // The call settled succeeded with the recovered result.
    expect(state.$resilience.calls.do_fetch).toEqual({
      phase: "succeeded",
      result: { type: "loaded", body: "OK" },
    });
  });

  it("a cold attempt DURING cooldown is fast-failed with no carrier (regression isolation)", () => {
    const wrapped = makeWrapped();
    // Trip at T, then a single cold attempt at T+10 (inside cooldown 50).
    const { state, cmds } = replay(wrapped, {
      msgs: [
        { type: "load", url: "/x", at: T },
        { type: "$resilience:err", key: "do_fetch", error: "boom", at: T },
        { type: "load", url: "/x", at: T + 10 },
      ] as readonly FetchMsg[],
      ctx,
    });
    // Only the FIRST cold attempt emitted a carrier; the during-cooldown one was
    // fast-failed (circuit_open), so the breaker is still open and protecting the
    // target.
    expect(cmds.filter((c) => c.type === "$resilience:run").length).toBe(1);
    expect(state.$resilience.circuit.phase).toBe("open");
    expect(state.$resilience.calls.do_fetch?.phase).toBe("circuit_open");
  });

  it("WITHOUT the fix the post-cooldown attempt would never recover (negative-elapsed witness)", () => {
    // This is the mechanical witness for the CRITICAL bug: under the old `at = 0`
    // cold gate, `canPass` computes `elapsed = 0 - openedAtMs = -T < cooldown`
    // for ANY cooldown, so a post-cooldown cold attempt is fast-failed forever.
    // With the fix the cold gate uses the Msg's real `at`, so `elapsed = 100 ≥
    // cooldown` admits the probe. We assert the FIXED behavior: the
    // post-cooldown attempt is admitted (a carrier is emitted for it).
    const wrapped = makeWrapped();
    const { cmds } = replay(wrapped, {
      msgs: [
        { type: "load", url: "/x", at: T },
        { type: "$resilience:err", key: "do_fetch", error: "boom", at: T },
        { type: "load", url: "/x", at: T + COOLDOWN }, // exactly at the edge.
      ] as readonly FetchMsg[],
      ctx,
    });
    // Two carriers: the initial admit AND the edge-of-cooldown recovery admit.
    // Under the `at = 0` bug this would be ONE (the edge attempt stays fast-failed
    // because `0 - T < cooldown`).
    expect(cmds.filter((c) => c.type === "$resilience:run").length).toBe(2);
  });
});

// ===========================================================================
// Gate coverage (LOW) — the conformance gate only folds [load, note], so the
// fail / onTimer / succeed cells are never purity-checked under two ambients. A
// dedicated two-ambient replay folds a log that INCLUDES `$resilience:err` and
// `$resilience:timer` (and `$resilience:ok`) so those cells prove pure: the
// slice is identical under A0 vs A1 (the merged update reads no wall clock; time
// enters only as Msg `at` / `atMs` data, identical across replays).
// ===========================================================================

describe("withResilience — fail/onTimer/succeed cells are pure under two ambients", () => {
  const ctx: FetchCtx = { fetchUrl: async () => "x", logLine: () => {} };
  const T = 7_000_000;

  it("the slice is identical under A0 vs A1 for a log touching err + timer + ok cells", () => {
    const base = makeBase();
    const wrapped = withResilience(
      base,
      {
        target: "do_fetch",
        at: atOf,
        circuit: { threshold: 5, cooldownMs: 50 },
        retry: {
          baseMs: 100,
          factor: 2,
          capMs: 1000,
          maxAttempts: 5,
          jitter: "none",
        },
      },
      () => 0.5,
    );

    // A log that exercises EVERY $resilience:* cell:
    //   - load            → base cell + cold attempt (admit)
    //   - $resilience:err  → fail cell (backoff → waiting_retry, retry timer armed)
    //   - $resilience:timer→ onTimer cell (retry timer fires → re-gate → re-run)
    //   - $resilience:ok   → succeed cell (close breaker, reset retry, settle ok)
    const msgs: readonly FetchMsg[] = [
      { type: "load", url: "/x", at: T },
      { type: "$resilience:err", key: "do_fetch", error: "boom", at: T },
      {
        type: "$resilience:timer",
        id: "$resilience:retry:do_fetch",
        atMs: T + 200,
      },
      {
        type: "$resilience:ok",
        key: "do_fetch",
        result: { type: "loaded", body: "OK" },
        at: T + 300,
      },
    ] as readonly FetchMsg[];

    const now = vi.spyOn(Date, "now");
    const rand = vi.spyOn(Math, "random");
    try {
      // Ambient A0.
      now.mockReturnValue(1_000_000);
      rand.mockReturnValue(0.123);
      const a = replay(wrapped, { msgs, ctx });
      // Ambient A1 — a DISTINCT wall clock + RNG.
      now.mockReturnValue(9_876_543);
      rand.mockReturnValue(0.987);
      const b = replay(wrapped, { msgs, ctx });
      // The fail / onTimer / succeed cells are PURE: the slice is a function of
      // the Msg log alone, identical across the two ambients.
      expect(b.state.$resilience).toEqual(a.state.$resilience);
      // And it actually drove those cells (not a no-op log): the breaker closed
      // on the ok, and the call settled succeeded.
      expect(a.state.$resilience.circuit).toEqual({
        phase: "closed",
        failures: 0,
      });
      expect(a.state.$resilience.calls.do_fetch).toEqual({
        phase: "succeeded",
        result: { type: "loaded", body: "OK" },
      });
    } finally {
      now.mockRestore();
      rand.mockRestore();
    }
  });
});

// ===========================================================================
// Init retag-admit (MEDIUM) — a target Cmd emitted by base.init is RETAGGED
// (admitted) into a `$resilience:run` carrier, never passed through raw. At a
// fresh boot the breaker is closed and the bucket full, so the gate decision is
// ADMIT — but the Cmd must still be observed via the carrier (rule 2).
// ===========================================================================

describe("withResilience — init retags (admits) a target Cmd from base.init", () => {
  const ctx: FetchCtx = { fetchUrl: async () => "x", logLine: () => {} };

  function makeBootBase() {
    // A base whose init emits BOTH a non-target `log` and the target `do_fetch`.
    return defineMachine<FetchState, FetchMsg, FetchCmd, never, FetchCtx>({
      init: (loaded) => [
        loaded ?? { url: "/boot", body: null },
        [
          { type: "log", line: "booting" },
          { type: "do_fetch", url: "/boot" },
        ],
      ],
      update: {
        load: (_s, m) => [{ url: m.url, body: null }, []],
        loaded: (s, m) => [{ ...s, body: m.body }, []],
        note: (s) => [s, [{ type: "log", line: "noted" }]],
      },
      interpret: {
        do_fetch: async (cmd, c): Promise<FetchMsg> => ({
          type: "loaded",
          body: await c.fetchUrl(cmd.url),
        }),
        log: async (cmd, c) => {
          c.logLine(cmd.line);
        },
      },
    });
  }

  it("the boot target Cmd is RETAGGED into $resilience:run, never raw; non-target passes through", () => {
    const base = makeBootBase();
    const wrapped = withResilience(base, { target: "do_fetch" }, () => 0.5);
    const { cmds, state } = replay(wrapped, { msgs: [], ctx });

    // No raw target at boot.
    expect(cmds.find((c) => c.type === "do_fetch")).toBeUndefined();
    // The non-target `log` boots through byte-identical.
    expect(cmds.find((c) => c.type === "log")).toEqual({
      type: "log",
      line: "booting",
    });
    // The boot target is retagged into the carrier (admitted at boot).
    const run = cmds.find((c) => c.type === "$resilience:run") as
      | ResilienceRunCmd<FetchCmd>
      | undefined;
    expect(run).toBeDefined();
    expect(run?.input).toEqual({ type: "do_fetch", url: "/boot" });
    // The slice recorded the admitted boot call as `running` — observed, not raw.
    expect(state.$resilience.calls.do_fetch?.phase).toBe("running");
  });

  it("rehydrate (loaded non-null) returns [loaded, []] with no boot Cmds", () => {
    const base = makeBootBase();
    const wrapped = withResilience(base, { target: "do_fetch" }, () => 0.5);
    const loaded = {
      base: { url: "/saved", body: "saved" },
      $resilience: wrapped.init(null, ctx)[0].$resilience,
    };
    const { cmds, state } = replay(wrapped, { msgs: [], ctx, loaded });
    // Rehydrate is a pure passthrough — no boot Cmds (the substrate enforces it).
    expect(cmds).toEqual([]);
    expect(state.base).toEqual({ url: "/saved", body: "saved" });
  });

  // FINDING #3 — boot deadline insta-fire. init gates the boot target Cmd at
  // `at = 0` (boot has no time-as-data). For circuit / rateLimit / cache that is
  // harmless at a fresh boot (admit is correct). The DEADLINE brick is NOT: it
  // anchors the cap at `0 + ms`, so its `$resilience:deadline` Sub arms at
  // `atMs = ms` and `subscribeDeadline` fires after `max(0, atMs - now) === 0`
  // ms — IMMEDIATELY, failing the boot call instantly. init() THROWS a clear
  // error directing the boot effect to a post-run boot Msg (where a real `at`
  // exists), mirroring the substrate guidance that boot effects belong in a
  // boot Msg, not init Cmds.
  it("init THROWS when base.init emits the target Cmd AND a deadline brick is configured", () => {
    const base = makeBootBase();
    const wrapped = withResilience(
      base,
      {
        target: "do_fetch",
        at: atOf,
        // deadline configured + base.init emits `do_fetch` → boot deadline would
        // anchor at 0 + 5000 and insta-fire. Refuse to arm it; fail loud.
        deadline: { ms: 5_000 },
      },
      () => 0.5,
    );
    // The throw is at init time — neither replay (which calls init) nor a direct
    // init() call may silently arm a 0-anchored boot deadline.
    expect(() => wrapped.init(null, ctx)).toThrow(
      /base\.init emits the target Cmd .* deadline brick is configured/,
    );
    expect(() => replay(wrapped, { msgs: [], ctx })).toThrow(
      /fire IMMEDIATELY/,
    );
  });

  it("a circuit-only init-target-Cmd (NO deadline) still boots: admit + retag, no insta-fire", () => {
    const base = makeBootBase();
    const wrapped = withResilience(
      base,
      {
        target: "do_fetch",
        at: atOf,
        // A time-sensitive brick WITHOUT deadline — boot is harmless: the breaker
        // is closed, so the cold gate admits and retags, and no deadline Sub is
        // armed, so there is nothing to insta-fire.
        circuit: { threshold: 2, cooldownMs: 50 },
      },
      () => 0.5,
    );
    // init does not throw, boots cleanly.
    expect(() => wrapped.init(null, ctx)).not.toThrow();
    const { cmds, state } = replay(wrapped, { msgs: [], ctx });
    // No raw target at boot; it is retagged into the carrier (admitted).
    expect(cmds.find((c) => c.type === "do_fetch")).toBeUndefined();
    const run = cmds.find((c) => c.type === "$resilience:run") as
      | ResilienceRunCmd<FetchCmd>
      | undefined;
    expect(run?.input).toEqual({ type: "do_fetch", url: "/boot" });
    // The slice recorded the admitted boot call as `running` — admitted, not
    // settled-failed by an insta-fired deadline.
    expect(state.$resilience.calls.do_fetch?.phase).toBe("running");
    // No deadline Sub is armed for this boot call (no deadline brick).
    expect(
      wrapped.subscriptions(state).some((s) => s.type === "$resilience:timer"),
    ).toBe(false);
  });
});

// ===========================================================================
// Property test — the merged update is PURE. Two independent replays of the
// same log agree; the slice is JSON-round-trip stable; the base slice matches
// the bare base run for every log; the target never escapes raw.
// ===========================================================================

describe("withResilience — properties", () => {
  const ctx: FetchCtx = { fetchUrl: async () => "x", logLine: () => {} };

  const arbMsgs = fc.array(
    fc.oneof(
      fc
        .tuple(
          fc.string({ minLength: 1, maxLength: 4 }),
          // The triggering Msg carries its own wall time as data (time-as-data),
          // so the cold-attempt gate reads a REAL instant, never a fabricated 0.
          fc.integer({ min: 0, max: 10_000_000 }),
        )
        .map(([url, at]) => ({ type: "load", url: `/${url}`, at }) as FetchMsg),
      fc.constant({ type: "note" } as FetchMsg),
      fc
        .string({ minLength: 1, maxLength: 4 })
        .map((body) => ({ type: "loaded", body }) as FetchMsg),
    ),
    { maxLength: 24 },
  );

  it("replay is referentially pure and the target never escapes raw", () => {
    const base = makeBase();
    fc.assert(
      fc.property(arbMsgs, (msgs) => {
        const wrapped = withResilience(
          base,
          {
            target: "do_fetch",
            at: atOf,
            keyOf: (c) => (c as DoFetchCmd).url,
            circuit: { threshold: 2, cooldownMs: 50 },
            retry: {
              baseMs: 100,
              factor: 2,
              capMs: 1000,
              maxAttempts: 5,
              jitter: "none",
            },
          },
          () => 0.5,
        );
        // Two independent replays of the same log agree (no folded clock/RNG).
        const a = replay(wrapped, { msgs, ctx });
        const b = replay(wrapped, { msgs, ctx });
        expect(b.state).toEqual(a.state);
        // The slice is JSON-round-trip stable — durable, never a closure.
        expect(JSON.parse(JSON.stringify(a.state.$resilience))).toEqual(
          a.state.$resilience,
        );
        // The base slice matches the bare base run for every log.
        const bare = replay(base, { msgs, ctx });
        expect(a.state.base).toEqual(bare.state);
        // No raw target Cmd ever escapes — always retagged into the carrier.
        expect(a.cmds.find((c) => c.type === "do_fetch")).toBeUndefined();
      }),
    );
  });

  it("under two distinct ambient clocks the slice is identical (update reads no wall clock)", () => {
    const base = makeBase();
    const wrapped = withResilience(
      base,
      {
        target: "do_fetch",
        retry: {
          baseMs: 100,
          factor: 2,
          capMs: 1000,
          maxAttempts: 5,
          jitter: "none",
        },
      },
      () => 0.5,
    );
    const msgs: readonly FetchMsg[] = [
      { type: "load", url: "/a", at: 1_000 },
      { type: "note" },
      { type: "load", url: "/b", at: 2_000 },
    ];
    const now = vi.spyOn(Date, "now");
    const rand = vi.spyOn(Math, "random");
    try {
      now.mockReturnValue(111);
      rand.mockReturnValue(0.1);
      const a = replay(wrapped, { msgs, ctx });
      now.mockReturnValue(999_999);
      rand.mockReturnValue(0.9);
      const b = replay(wrapped, { msgs, ctx });
      expect(b.state.$resilience).toEqual(a.state.$resilience);
    } finally {
      now.mockRestore();
      rand.mockRestore();
    }
  });
});
