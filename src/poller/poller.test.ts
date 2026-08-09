import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DeadlineExceeded,
  deadlineSub,
  subscribeDeadline,
} from "../deadline";
import { type Cmd, defineMachine, run } from "../index";
import {
  type DurationRetryPolicy,
  defaultRetryPolicy,
  type RetryPolicy,
  type TimedRetryState,
} from "../retry-backoff";
import { bindMachine } from "../testing";
import { createPoller, type PollerState } from "./index";

// A tick result shape we poll for: a status that flips to "ready" eventually.
type Status = { readonly status: "pending" | "ready"; readonly etag?: string };

// The Cmd the poller's `onTick` emits — the consumer's "go observe" effect.
const FETCH: Cmd<"fetch_status"> = { type: "fetch_status" };

// A no-jitter, low-attempt policy so backoff delays are exactly predictable and
// the give-up edge is reachable in a couple of failures.
const noJitter: RetryPolicy = {
  baseMs: 100,
  factor: 2,
  capMs: 10_000,
  maxAttempts: 3,
  jitter: "none",
};

const BASE = 1_000_000; // a readable epoch instant for absolute targets.
const rngZero = () => 0; // pins jitter when a policy has any.

// Build the rotating tick-Sub id the knob arms under (keyed on the absolute
// target so each cadence/backoff re-arm is a distinct identity the substrate's
// reconcile pass retires + re-arms). Tests assert against this exact shape.
const tickSub = (atMs: number) => deadlineSub(`poller:tick:${atMs}`, atMs);

// A poller keyed on the result status. `until` holds once we observe "ready".
// `rng` is injected at the factory (pinned to zero) so backoff is deterministic
// — no verb ever names the global RNG.
function makePoller(
  over?: Partial<Parameters<typeof createPoller<unknown, Status>>[0]>,
) {
  return createPoller<unknown, Status>(
    {
      everyMs: 5_000,
      until: () => false, // overridden per call site via `untilHeld`
      onTick: () => FETCH,
      retry: noJitter,
      ...over,
    },
    rngZero,
  );
}

describe("createPoller — init / start", () => {
  it("init seeds an idle-but-polling slice with no target armed", () => {
    const poll = makePoller();
    expect(poll.init()).toEqual({
      tick: 0,
      retry: { attempt: 0 },
      nextAtMs: null,
      phase: "polling",
      dedupe: { entries: {}, order: [], capacity: undefined, ttlMs: undefined },
    });
  });

  it("start arms the first deadline one cadence out and emits NO cmd (timer is the only next-tick mechanism)", () => {
    const poll = makePoller();
    const [next, cmds] = poll.start(poll.init(), BASE);
    expect(next.nextAtMs).toBe(BASE + 5_000);
    expect(next.phase).toBe("polling");
    // No immediate observation: the first fetch fires when the deadline crosses
    // BASE + 5_000 and the consumer routes deadline_exceeded → tick.
    expect(cmds).toEqual([]);
  });
});

describe("createPoller — tick (the cadence verb)", () => {
  it("emits exactly one onTick Cmd when polling and does not touch the schedule", () => {
    const poll = makePoller();
    const armed = poll.start(poll.init(), BASE)[0];
    const [next, cmds] = poll.tick(armed);
    expect(cmds).toEqual([FETCH]); // the SOLE place the fetch is emitted
    expect(next).toBe(armed); // schedule untouched — re-arm happens on the result
  });

  it("is a no-op on a finished poller (stale fire racing a terminal transition)", () => {
    const poll = makePoller();
    const done = poll.tickResult(
      poll.start(poll.init(), BASE)[0],
      { status: "ready" },
      BASE + 5_000,
      true,
    )[0];
    const [next, cmds] = poll.tick(done);
    expect(cmds).toEqual([]);
    expect(next).toBe(done);
  });
});

describe("createPoller — tickResult (steady cadence)", () => {
  it("reschedules at the steady cadence and emits no cadence cmd while not done", () => {
    const poll = makePoller();
    const armed = poll.start(poll.init(), BASE)[0];
    const [next, cmds] = poll.tickResult(
      armed,
      { status: "pending" },
      BASE + 5_000,
      false,
    );

    expect(next.tick).toBe(1);
    expect(next.lastResult).toEqual({ status: "pending" });
    expect(next.nextAtMs).toBe(BASE + 10_000); // at + everyMs, anchored on the tick `at`
    expect(next.phase).toBe("polling");
    // The next fetch comes from the re-armed deadline, NOT immediately here.
    expect(cmds).toEqual([]);
  });

  it("a success resets the retry counter accumulated by prior failures", () => {
    const poll = makePoller();
    const failed = poll.tickErr(
      poll.start(poll.init(), BASE)[0],
      "boom",
      BASE,
    )[0];
    expect(failed.retry.attempt).toBe(1);

    const [recovered] = poll.tickResult(
      failed,
      { status: "pending" },
      BASE + 100,
      false,
    );
    expect(recovered.retry).toEqual({ attempt: 0 });
  });

  it("when until holds the poller is DONE: disarms and emits nothing", () => {
    const poll = makePoller();
    const armed = poll.start(poll.init(), BASE)[0];
    const [done, cmds] = poll.tickResult(
      armed,
      { status: "ready" },
      BASE + 5_000,
      true,
    );

    expect(done.phase).toBe("done");
    expect("nextAtMs" in done).toBe(false); // done arm carries no target (unrepresentable)
    expect(done.lastResult).toEqual({ status: "ready" }); // final datum still recorded
    expect(cmds).toEqual([]);
  });

  it("does not mutate the input state (returns a fresh slice)", () => {
    const poll = makePoller();
    const armed = Object.freeze(poll.start(poll.init(), BASE)[0]);
    const [next] = poll.tickResult(
      armed,
      { status: "pending" },
      BASE + 5_000,
      false,
    );
    expect(next).not.toBe(armed);
    expect(armed.tick).toBe(0); // input untouched
  });
});

describe("createPoller — tickErr (backoff)", () => {
  it("arms the next attempt on the backoff curve, emits no cmd (retry fires from the timer)", () => {
    const poll = makePoller();
    const armed = poll.start(poll.init(), BASE)[0];

    // First failure: attempt → 1, delay = nextDelayMs at attempt 1 =
    // baseMs * factor**1 = 200 (the counter advances before the delay is read,
    // so the backoff is keyed on failures-so-far, not the pre-increment index).
    const [f1, c1] = poll.tickErr(armed, "boom", BASE);
    expect(f1.retry.attempt).toBe(1);
    expect(f1.nextAtMs).toBe(BASE + 200);
    expect(f1.phase).toBe("polling");
    expect(c1).toEqual([]); // retry observation fires when the backoff deadline crosses

    // Second failure: attempt → 2, delay = baseMs * factor**2 = 400.
    const [f2] = poll.tickErr(f1, "boom", BASE + 200);
    expect(f2.retry.attempt).toBe(2);
    expect(f2.nextAtMs).toBe(BASE + 200 + 400);
  });

  it("gives up once backoff exhausts maxAttempts: disarms and emits nothing", () => {
    const poll = makePoller();
    let s = poll.start(poll.init(), BASE)[0];
    // maxAttempts is 3: failures 1 and 2 still retry, failure 3 gives up.
    s = poll.tickErr(s, "e", BASE)[0];
    s = poll.tickErr(s, "e", BASE)[0];
    const [givenUp, cmds] = poll.tickErr(s, "e", BASE);

    expect(givenUp.retry.attempt).toBe(3);
    expect(givenUp.phase).toBe("gave_up");
    expect("nextAtMs" in givenUp).toBe(false); // gave_up arm carries no target
    expect(cmds).toEqual([]);
  });

  it("backoff jitter uses the factory-injected rng (no global RNG in the verb)", () => {
    // A "full" jitter policy: delay = rng() * d. With rng pinned to 0.5 at the
    // factory, attempt-1 delay = 0.5 * (100 * 2**1) = 100. The verb body never
    // names Math.random — determinism comes from the injected rng alone.
    const half = () => 0.5;
    const poll = createPoller<unknown, Status>(
      {
        everyMs: 5_000,
        until: () => false,
        onTick: () => FETCH,
        retry: { ...noJitter, jitter: "full" },
      },
      half,
    );
    const armed = poll.start(poll.init(), BASE)[0];
    const [f1] = poll.tickErr(armed, "boom", BASE);
    expect(f1.nextAtMs).toBe(BASE + 100); // 0.5 * 200
  });
});

describe("createPoller — dedupe", () => {
  it("suppresses the onTick follow-up for a repeated observation key", () => {
    const poll = makePoller({ dedupeKey: (r) => r.etag ?? "none" });
    const armed = poll.start(poll.init(), BASE)[0];

    // First sighting of etag "v1": fresh → emits the onTick follow-up.
    const [first, c1] = poll.tickResult(
      armed,
      { status: "pending", etag: "v1" },
      BASE + 5_000,
      false,
    );
    expect(c1).toEqual([FETCH]);

    // Same etag again: recorded, schedule still advances, but NO fresh follow-up.
    const [second, c2] = poll.tickResult(
      first,
      { status: "pending", etag: "v1" },
      BASE + 10_000,
      false,
    );
    expect(c2).toEqual([]); // duplicate side effect suppressed
    expect(second.nextAtMs).toBe(BASE + 15_000); // polling continues

    // A new etag is fresh again → emits the follow-up.
    const [, c3] = poll.tickResult(
      second,
      { status: "pending", etag: "v2" },
      BASE + 15_000,
      false,
    );
    expect(c3).toEqual([FETCH]);
  });

  it("without dedupeKey tickResult emits nothing (cadence tick is the only fetch; store never written)", () => {
    const poll = makePoller();
    const armed = poll.start(poll.init(), BASE)[0];
    const [a, ca] = poll.tickResult(
      armed,
      { status: "pending", etag: "v1" },
      BASE + 5_000,
      false,
    );
    const [, cb] = poll.tickResult(
      a,
      { status: "pending", etag: "v1" },
      BASE + 10_000,
      false,
    );
    expect(ca).toEqual([]); // no immediate cmd — the timer drives the next fetch
    expect(cb).toEqual([]);
    expect(a.dedupe.order).toEqual([]); // store never touched
  });

  it("defaults the retry policy to defaultRetryPolicy when omitted", () => {
    const poll = createPoller<unknown, Status>(
      {
        everyMs: 1_000,
        until: () => false,
        onTick: () => FETCH,
      },
      rngZero,
    );
    // Drive failures up to the default cap and confirm give-up lands there.
    let s = poll.start(poll.init(), 0)[0];
    for (let i = 0; i < defaultRetryPolicy.maxAttempts - 1; i++) {
      s = poll.tickErr(s, "e", 0)[0];
      expect(s.phase).toBe("polling");
    }
    s = poll.tickErr(s, "e", 0)[0];
    expect(s.phase).toBe("gave_up");
  });
});

describe("createPoller — subs", () => {
  it("arms exactly the tick deadline (id keyed on the target) while polling", () => {
    const poll = makePoller();
    const armed = poll.start(poll.init(), BASE)[0];
    expect(poll.subs(armed)).toEqual([tickSub(BASE + 5_000)]);
  });

  it("rotates the sub id with the target so the reconcile pass re-arms each cadence", () => {
    const poll = makePoller();
    const armed = poll.start(poll.init(), BASE)[0];
    const after = poll.tickResult(
      armed,
      { status: "pending" },
      BASE + 5_000,
      false,
    )[0];
    // Distinct ids → the substrate retires the spent timer and arms the next.
    expect((poll.subs(armed)[0] as ReturnType<typeof deadlineSub>).id).toBe(
      "poller:tick:1005000",
    );
    expect((poll.subs(after)[0] as ReturnType<typeof deadlineSub>).id).toBe(
      "poller:tick:1010000",
    );
  });

  it("disarms (returns []) when done, gave up, or not yet started", () => {
    const poll = makePoller();
    expect(poll.subs(poll.init())).toEqual([]); // nextAtMs null pre-start

    const done = poll.tickResult(
      poll.start(poll.init(), BASE)[0],
      { status: "ready" },
      BASE,
      true,
    )[0];
    expect(poll.subs(done)).toEqual([]);

    let gu = poll.start(poll.init(), BASE)[0];
    gu = poll.tickErr(gu, "e", BASE)[0];
    gu = poll.tickErr(gu, "e", BASE)[0];
    gu = poll.tickErr(gu, "e", BASE)[0];
    expect(gu.phase).toBe("gave_up");
    expect(poll.subs(gu)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Machine-level (pure fold via bindMachine): spread the knob into a real
// machine and assert through `replay`. The deadline Sub fires
// `deadline_exceeded` → `tick` → FETCH; results fold back and re-arm.
// ---------------------------------------------------------------------------

type AppState = { readonly poll: PollerState<Status> };
type AppMsg =
  | { readonly type: "begin"; readonly at: number }
  | {
      readonly type: "deadline_exceeded";
      readonly id: string;
      readonly atMs: number;
    }
  | { readonly type: "tick_ok"; readonly result: Status; readonly at: number }
  | { readonly type: "tick_err"; readonly error: unknown; readonly at: number };

const poll = makePoller({
  until: (s) => (s as AppState).poll.lastResult?.status === "ready",
});

function pollerMachine() {
  return defineMachine<
    AppState,
    AppMsg,
    Cmd<"fetch_status">,
    DeadlineExceeded,
    undefined
  >({
    init: (loaded) => [loaded ?? { poll: poll.init() }, []],
    update: {
      begin: (s, m) => {
        const [slice, cmds] = poll.start(s.poll, m.at);
        return [{ ...s, poll: slice }, cmds];
      },
      // The deadline crossed: the consumer routes it to the cadence verb, the
      // SOLE emitter of the fetch Cmd.
      deadline_exceeded: (s) => {
        const [slice, cmds] = poll.tick(s.poll);
        return [{ ...s, poll: slice }, cmds];
      },
      tick_ok: (s, m) => {
        // The consumer folds the result, THEN evaluates `until` on the new
        // Model and threads the boolean into the verb.
        const folded: AppState = {
          ...s,
          poll: { ...s.poll, lastResult: m.result },
        };
        const untilHeld = folded.poll.lastResult?.status === "ready";
        const [slice, cmds] = poll.tickResult(
          s.poll,
          m.result,
          m.at,
          untilHeld,
        );
        return [{ ...s, poll: slice }, cmds];
      },
      tick_err: (s, m) => {
        const [slice, cmds] = poll.tickErr(s.poll, m.error, m.at);
        return [{ ...s, poll: slice }, cmds];
      },
    },
    subscriptions: (s) => poll.subs(s.poll),
    subscribe: { deadline: subscribeDeadline },
    interpret: {
      // Default interpret is a no-op for the pure-fold (bindMachine) tests; the
      // real-runtime test below overrides it to perform the source read.
      fetch_status: async () => undefined,
    },
  });
}

describe("createPoller — wired into a machine (pure fold)", () => {
  const machine = pollerMachine();
  const t = bindMachine(machine, undefined);

  it("a deadline fire emits exactly one fetch; a non-final result re-arms with no extra fetch", () => {
    // begin (no cmd) → deadline fires (FETCH) → result folds (no cmd, re-arm).
    t.expectCmdSequence(
      {
        msgs: [
          { type: "begin", at: BASE },
          {
            type: "deadline_exceeded",
            id: "poller:tick:1005000",
            atMs: BASE + 5_000,
          },
          { type: "tick_ok", result: { status: "pending" }, at: BASE + 5_000 },
        ],
      },
      [FETCH],
    );
  });

  it("a full begin → fire → pending → fire → ready run emits one fetch PER deadline, then stops", () => {
    t.expectCmdSequence(
      {
        msgs: [
          { type: "begin", at: BASE },
          {
            type: "deadline_exceeded",
            id: "poller:tick:1005000",
            atMs: BASE + 5_000,
          },
          { type: "tick_ok", result: { status: "pending" }, at: BASE + 5_000 },
          {
            type: "deadline_exceeded",
            id: "poller:tick:1010000",
            atMs: BASE + 10_000,
          },
          { type: "tick_ok", result: { status: "ready" }, at: BASE + 10_000 },
        ],
      },
      // Two deadline fires → two fetches; the ready result terminates (no fetch).
      [FETCH, FETCH],
    );
  });

  it("arms the rotating tick deadline mid-run, drops it once ready", () => {
    t.expectActiveSubs(
      {
        msgs: [
          { type: "begin", at: BASE },
          {
            type: "deadline_exceeded",
            id: "poller:tick:1005000",
            atMs: BASE + 5_000,
          },
          { type: "tick_ok", result: { status: "pending" }, at: BASE + 5_000 },
        ],
      },
      [tickSub(BASE + 10_000)],
    );

    t.expectActiveSubs(
      {
        msgs: [
          { type: "begin", at: BASE },
          {
            type: "deadline_exceeded",
            id: "poller:tick:1005000",
            atMs: BASE + 5_000,
          },
          { type: "tick_ok", result: { status: "ready" }, at: BASE + 5_000 },
        ],
      },
      [], // done → timer disarmed
    );
  });
});

// ---------------------------------------------------------------------------
// WIRED MACHINE — real `run()` loop driven by the REAL deadline timer.
//
// This is the systemic root test the bug slipped past: a real Runtime whose
// `subscribe.deadline` arms an actual `setTimeout` (via `subscribeDeadline`,
// reading the fake clock), whose `interpret.fetch_status` performs the source
// read and re-enters the bound machine by RETURNING the follow-up Msg the
// substrate dispatches. We drive wall-clock time with fake timers and assert
// the END STATE + that EXACTLY ONE fetch fires per `everyMs` window.
//
// Against the buggy code (`start`/`tickResult` returned an immediate
// `[onTick()]`), the runtime would fetch as fast as the source resolves —
// `begin` → fetch → result → fetch → result → … — a tight loop that drains the
// source with NO time advancing. The "exactly one fetch before the first
// timer advance" assertion fails on the buggy code and passes on the fix.
// ---------------------------------------------------------------------------

describe("createPoller — wired into a REAL runtime (timer-driven cadence)", () => {
  beforeEach(() => {
    // useFakeTimers mocks setTimeout/clearTimeout AND Date.now(), so the
    // deadline subscribe cell's `Date.now()` reads the same clock the test
    // advances. setSystemTime anchors `now` at BASE so absolute targets line up.
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Flush the microtask queue so the substrate's serial dispatch tail (and the
  // interpret follow-up enqueued onto it) settles between timer advances.
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  it("fires exactly one source read per everyMs window, never faster than the cadence", async () => {
    // The source: pending for the first two reads, ready on the third. A
    // mutable counter so we can count exactly how many times the runtime
    // actually performed the observation.
    let reads = 0;
    const sequence: Status[] = [
      { status: "pending" },
      { status: "pending" },
      { status: "ready" },
    ];
    const readSource = (): Status => {
      const r = sequence[Math.min(reads, sequence.length - 1)] ?? {
        status: "ready",
      };
      reads += 1;
      return r;
    };

    const machine = defineMachine<
      AppState,
      AppMsg,
      Cmd<"fetch_status">,
      DeadlineExceeded,
      undefined
    >({
      init: () => [{ poll: poll.init() }, []],
      update: {
        begin: (s, m) => {
          const [slice, cmds] = poll.start(s.poll, m.at);
          return [{ ...s, poll: slice }, cmds];
        },
        deadline_exceeded: (s) => {
          const [slice, cmds] = poll.tick(s.poll);
          return [{ ...s, poll: slice }, cmds];
        },
        tick_ok: (s, m) => {
          const folded: AppState = {
            ...s,
            poll: { ...s.poll, lastResult: m.result },
          };
          const untilHeld = folded.poll.lastResult?.status === "ready";
          const [slice, cmds] = poll.tickResult(
            s.poll,
            m.result,
            m.at,
            untilHeld,
          );
          return [{ ...s, poll: slice }, cmds];
        },
        tick_err: (s, m) => {
          const [slice, cmds] = poll.tickErr(s.poll, m.error, m.at);
          return [{ ...s, poll: slice }, cmds];
        },
      },
      subscriptions: (s) => poll.subs(s.poll),
      subscribe: { deadline: subscribeDeadline },
      interpret: {
        // Perform the observation and re-enter the machine with the result Msg
        // the substrate dispatches onto its tail (the runtime's dispatch).
        fetch_status: async (): Promise<AppMsg> => ({
          type: "tick_ok",
          result: readSource(),
          at: Date.now(),
        }),
      },
    });

    const runtime = await run(machine, { ctx: undefined }).ready;

    // Kick the poller off. `start` arms the first deadline at BASE + 5_000 and
    // emits NOTHING — so no read has happened yet.
    await runtime.dispatch({ type: "begin", at: Date.now() });
    await flush();
    expect(reads).toBe(0); // cadence not yet due — the timer has not fired

    // Advance ALMOST one window: still nothing.
    await vi.advanceTimersByTimeAsync(4_999);
    await flush();
    expect(reads).toBe(0);

    // Cross the first deadline → the timer dispatches deadline_exceeded → tick
    // → exactly ONE fetch → one source read. Then the pending result re-arms.
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(reads).toBe(1);

    // Within the SAME window (before the next deadline) no extra read fires —
    // this is the property the buggy immediate-onTick code violated.
    await vi.advanceTimersByTimeAsync(4_999);
    await flush();
    expect(reads).toBe(1);

    // Second window crosses → second read (still pending) → re-arm.
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(reads).toBe(2);

    // Third window crosses → third read returns "ready" → poller is DONE.
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(reads).toBe(3);

    // END STATE: terminal `done`, the timer disarmed, the final datum recorded.
    const end = runtime.getState();
    expect(end.poll.phase).toBe("done");
    expect("nextAtMs" in end.poll).toBe(false); // done arm carries no target
    expect(end.poll.lastResult).toEqual({ status: "ready" });

    // The poll is settled: no further reads no matter how long we wait.
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(reads).toBe(3);

    await runtime.stop();
  });
});

// ---------------------------------------------------------------------------
// Property tests — invariants that must hold across arbitrary tick sequences.
// ---------------------------------------------------------------------------

describe("createPoller — properties", () => {
  it("a non-final success always schedules the next tick exactly everyMs ahead", () => {
    const everyMsArb = fc.integer({ min: 1, max: 1_000_000 });
    const atArb = fc.integer({ min: 0, max: 10_000_000 });
    fc.assert(
      fc.property(everyMsArb, atArb, (everyMs, at) => {
        const p = makePoller({ everyMs });
        const armed = p.start(p.init(), 0)[0];
        const [next] = p.tickResult(armed, { status: "pending" }, at, false);
        return next.nextAtMs === at + everyMs && next.phase === "polling";
      }),
    );
  });

  it("no verb except `tick` ever emits a Cmd without dedupe configured (cadence is timer-only)", () => {
    // start, tickResult (non-final), tickErr (retry) all emit []; only `tick`
    // emits the fetch. This is the structural form of "ONE next-tick mechanism".
    const stepArb = fc.constantFrom<"ok" | "err">("ok", "err");
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 12 }), (steps) => {
        const p = makePoller();
        let s = p.start(p.init(), 0)[0];
        if (p.start(p.init(), 0)[1].length !== 0) return false; // start emits nothing
        let at = 0;
        for (const step of steps) {
          if (s.phase !== "polling") break;
          at += 1_000;
          const [ns, cmds] =
            step === "ok"
              ? p.tickResult(s, { status: "pending" }, at, false)
              : p.tickErr(s, "e", at);
          if (cmds.length !== 0) return false; // never an immediate cmd
          s = ns;
        }
        return true;
      }),
    );
  });

  it("a finished poller (done OR gave_up) never schedules another tick", () => {
    const stepArb = fc.constantFrom<"ok" | "err">("ok", "err");
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 12 }), (steps) => {
        const p = makePoller();
        let s = p.start(p.init(), 0)[0];
        let at = 0;
        for (const step of steps) {
          if (s.phase !== "polling") break; // already terminal — stop folding
          at += 1_000;
          s =
            step === "ok"
              ? p.tickResult(s, { status: "pending" }, at, false)[0]
              : p.tickErr(s, "e", at)[0];
        }
        if (s.phase !== "polling") {
          // Already gave up mid-sequence: a terminal arm carries no target at all
          // (unrepresentable), and nothing is scheduled.
          return !("nextAtMs" in s) && p.subs(s).length === 0;
        }
        // Otherwise force a terminal success (until held) and assert it disarms.
        const [done, cmds] = p.tickResult(s, { status: "ready" }, at + 1, true);
        return (
          done.phase === "done" &&
          !("nextAtMs" in done) &&
          cmds.length === 0 &&
          p.subs(done).length === 0
        );
      }),
    );
  });

  it("subs returns the deadline iff polling with a target, with id+atMs keyed on nextAtMs", () => {
    const phaseArb = fc.constantFrom<PollerState<Status>["phase"]>(
      "polling",
      "done",
      "gave_up",
    );
    const targetArb = fc.option(fc.integer({ min: 0, max: 10_000_000 }), {
      nil: null,
    });
    fc.assert(
      fc.property(phaseArb, targetArb, (phase, nextAtMs) => {
        const p = makePoller();
        const state: PollerState<Status> = { ...p.init(), phase, nextAtMs };
        const subs = p.subs(state);
        const shouldArm = phase === "polling" && nextAtMs !== null;
        if (!shouldArm) return subs.length === 0;
        const sub = subs[0] as ReturnType<typeof deadlineSub>;
        return (
          subs.length === 1 &&
          sub.atMs === nextAtMs &&
          sub.id === `poller:tick:${nextAtMs}`
        );
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// DURATION-BOUNDED RETRY — the outage budget reaches the poller.
//
// `tickErr` already carried `at` (the failure's observation instant), so the
// streak clock is Msg data, not a clock read: `recordFailure` mints the origin
// and `shouldRetry` is told `now`. The bound a `config.retry` declares may
// therefore be temporal. The curve below is the downstream one from the
// retry-backoff commit — 250ms → 4s, budget 60s — where a count bound is the
// wrong bound because how many attempts fit in an outage is the carrier's
// business, not the policy's.
//
// Failure ladder (jitter "none", first failure at the streak origin `T`):
//   T+0  T+500  T+1500  T+3500  T+7500, then every 4000ms (the cap).
// The 18th failure sits at T+59500 (inside the 60s budget → retried); the 19th
// at T+63500 (outside → gave_up). A `maxAttempts` bound on the same curve quits
// at attempt 3 or 5 — a few seconds of patience against a minute of outage.
// ---------------------------------------------------------------------------

const outageBudget: DurationRetryPolicy = {
  baseMs: 250,
  factor: 2,
  capMs: 4_000,
  maxElapsedMs: 60_000,
  jitter: "none",
};

// The absolute instants the failure ladder above lands on, relative to the
// streak origin. Derived once so the unit fold and the wired run assert the
// SAME ladder rather than two hand-copied number lists.
const OUTAGE_LADDER: readonly number[] = (() => {
  const out = [0];
  let delay = 500; // 250 * 2**1 — the delay after the FIRST failure
  while (out[out.length - 1] !== undefined) {
    const next = (out[out.length - 1] as number) + delay;
    out.push(next);
    delay = Math.min(outageBudget.capMs, delay * outageBudget.factor);
    if (next > 70_000) break;
  }
  return out;
})();

// The last failure still inside the budget, and the first one outside it.
const LAST_INSIDE = OUTAGE_LADDER.filter(
  (t) => t < outageBudget.maxElapsedMs,
).length; // 18
const GIVE_UP_AT = OUTAGE_LADDER[LAST_INSIDE] as number; // 63500

describe("createPoller — duration-bounded retry (the outage budget)", () => {
  it("keeps retrying past where a count bound would have quit, then stops at the declared duration", () => {
    const poll = makePoller({ retry: outageBudget });
    let s = poll.start(poll.init(), BASE)[0];

    // Fold the whole outage: each failure is observed at the instant the
    // poller's own backoff target armed, so the ladder IS the schedule.
    let failures = 0;
    for (const offset of OUTAGE_LADDER) {
      if (s.phase !== "polling") break;
      const at = BASE + offset;
      // The armed target is exactly where the next failure is observed.
      expect(s.nextAtMs).toBe(failures === 0 ? BASE + 5_000 : at);
      const [next, cmds] = poll.tickErr(s, "peer_unreachable", at);
      expect(cmds).toEqual([]); // backoff never emits; the timer re-fires
      s = next;
      failures += 1;
    }

    // Stopped at the DURATION, not at a count: 19 consecutive failures, where
    // the count-bounded control policy (`noJitter`, maxAttempts 3) quits at 3.
    expect(s.phase).toBe("gave_up");
    expect(failures).toBe(LAST_INSIDE + 1);
    expect(failures).toBeGreaterThan(noJitter.maxAttempts);
    expect(failures).toBeGreaterThan(defaultRetryPolicy.maxAttempts);
    expect(s.retry.attempt).toBe(LAST_INSIDE + 1);

    // The give-up instant is the FIRST failure observed at or past the budget,
    // and the one before it was admitted from inside the budget.
    const origin = (s.retry as TimedRetryState).firstFailureAtMs;
    // The origin is the streak's FIRST failure — here `BASE + LADDER[0]` — not
    // `start`, and not the most recent failure.
    expect(origin).toBe(BASE + (OUTAGE_LADDER[0] as number));
    expect(GIVE_UP_AT).toBeGreaterThanOrEqual(outageBudget.maxElapsedMs);
    expect(OUTAGE_LADDER[LAST_INSIDE - 1] as number).toBeLessThan(
      outageBudget.maxElapsedMs,
    );
  });

  it("the same curve under a COUNT bound quits after maxAttempts — the bound is what differs", () => {
    // Control for the test above: identical curve, count bound instead. Proves
    // the extra patience comes from the BOUND, not from the ladder.
    const counted: RetryPolicy = {
      baseMs: outageBudget.baseMs,
      factor: outageBudget.factor,
      capMs: outageBudget.capMs,
      maxAttempts: 3,
      jitter: "none",
    };
    const poll = makePoller({ retry: counted });
    let s = poll.start(poll.init(), BASE)[0];
    let failures = 0;
    for (const offset of OUTAGE_LADDER) {
      if (s.phase !== "polling") break;
      s = poll.tickErr(s, "peer_unreachable", BASE + offset)[0];
      failures += 1;
    }
    expect(s.phase).toBe("gave_up");
    expect(failures).toBe(3);
  });

  it("a success drops the streak origin, so intermittent failures never accumulate outage", () => {
    const poll = makePoller({ retry: outageBudget });
    let s = poll.start(poll.init(), BASE)[0];

    // A long, BROKEN run: fail, succeed, fail, succeed … well past the budget.
    for (let i = 0; i < 40; i++) {
      s = poll.tickErr(s, "blip", BASE + i * 5_000)[0];
      expect(s.phase).toBe("polling"); // never gives up — each streak is 1 long
      expect((s.retry as TimedRetryState).firstFailureAtMs).toBe(
        BASE + i * 5_000,
      );
      s = poll.tickResult(
        s,
        { status: "pending" },
        BASE + i * 5_000 + 1,
        false,
      )[0];
      expect(s.retry).toEqual({ attempt: 0 }); // origin dropped with the streak
    }
  });

  it("the streak origin is set ONCE and preserved across the whole outage", () => {
    const poll = makePoller({ retry: outageBudget });
    let s = poll.start(poll.init(), BASE)[0];
    s = poll.tickErr(s, "e", BASE + 1_000)[0];
    const origin = (s.retry as TimedRetryState).firstFailureAtMs;
    expect(origin).toBe(BASE + 1_000);
    for (const offset of [2_000, 4_000, 9_000, 20_000]) {
      s = poll.tickErr(s, "e", BASE + offset)[0];
      expect((s.retry as TimedRetryState).firstFailureAtMs).toBe(origin);
    }
  });
});

// ---------------------------------------------------------------------------
// WIRED END-TO-END — a duration-bounded poller driven by the REAL deadline
// timer across a REAL (fake-clock) 63.5-second outage. The source is down for
// the whole run; nothing but the poller's own backoff ladder and the outage
// budget decides when it stops.
// ---------------------------------------------------------------------------

describe("createPoller — wired into a REAL runtime (duration-bounded outage)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };

  it("retries a 63.5s outage far past any count bound, and gives up at the 60s budget", async () => {
    // Every read fails; record WHEN the runtime actually performed it so the
    // backoff ladder is asserted from observed behaviour, not from the slice.
    const readAt: number[] = [];
    const durationPoll = createPoller<AppState, Status>(
      {
        everyMs: 5_000,
        until: (s) => s.poll.lastResult?.status === "ready",
        onTick: () => FETCH,
        retry: outageBudget,
      },
      rngZero,
    );

    const machine = defineMachine<
      AppState,
      AppMsg,
      Cmd<"fetch_status">,
      DeadlineExceeded,
      undefined
    >({
      init: () => [{ poll: durationPoll.init() }, []],
      update: {
        begin: (s, m) => {
          const [slice, cmds] = durationPoll.start(s.poll, m.at);
          return [{ ...s, poll: slice }, cmds];
        },
        deadline_exceeded: (s) => {
          const [slice, cmds] = durationPoll.tick(s.poll);
          return [{ ...s, poll: slice }, cmds];
        },
        tick_ok: (s, m) => {
          const [slice, cmds] = durationPoll.tickResult(
            s.poll,
            m.result,
            m.at,
            true,
          );
          return [{ ...s, poll: slice }, cmds];
        },
        tick_err: (s, m) => {
          const [slice, cmds] = durationPoll.tickErr(s.poll, m.error, m.at);
          return [{ ...s, poll: slice }, cmds];
        },
      },
      subscriptions: (s) => durationPoll.subs(s.poll),
      subscribe: { deadline: subscribeDeadline },
      interpret: {
        // The source is DOWN for the entire run — every observation fails.
        fetch_status: async (): Promise<AppMsg> => {
          readAt.push(Date.now());
          return {
            type: "tick_err",
            error: "peer_unreachable",
            at: Date.now(),
          };
        },
      },
    });

    const runtime = await run(machine, { ctx: undefined }).ready;
    await runtime.dispatch({ type: "begin", at: Date.now() });
    await flush();
    expect(readAt).toEqual([]); // the timer is the only next-tick mechanism

    // Drive 80 simulated seconds — comfortably past the 60s budget AND past the
    // 63.5s instant the ladder's out-of-budget failure lands on.
    for (let i = 0; i < 80; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
    }

    // END STATE — gave up on the DURATION.
    const end = runtime.getState();
    expect(end.poll.phase).toBe("gave_up");
    expect("nextAtMs" in end.poll).toBe(false);

    // The observed ladder: the first read on the `everyMs` cadence, then the
    // backoff curve, offset by the streak origin.
    const origin = readAt[0] as number;
    expect(origin).toBe(BASE + 5_000);
    expect(readAt.map((t) => t - origin)).toEqual(
      OUTAGE_LADDER.slice(0, LAST_INSIDE + 1),
    );

    // The whole point: 19 reads across a 63.5s outage, where a count bound on
    // the same curve would have stopped at 3 (or the default 5) — seconds of
    // patience against a minute of outage.
    expect(readAt.length).toBe(LAST_INSIDE + 1);
    expect(readAt.length).toBeGreaterThan(defaultRetryPolicy.maxAttempts);
    // …and it did STOP: the last read is the first one at/after the budget, and
    // no further read happens however long we wait.
    expect((readAt[readAt.length - 1] as number) - origin).toBe(GIVE_UP_AT);
    const settled = readAt.length;
    await vi.advanceTimersByTimeAsync(600_000);
    await flush();
    expect(readAt.length).toBe(settled);

    await runtime.stop();
  });
});
