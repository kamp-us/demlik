import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Cmd, defineMachine, noop, run, type Store } from "../index";
import { bindMachine } from "../testing";
import { createIntake, type IntakeCmd, type IntakeState } from "./index";

// A tiny payload + result domain for the unit specs. The webhook id IS the
// idempotency key, the most common real shape (Stripe / GitHub deliver one).
interface Hook {
  readonly id: string;
  readonly amount: number;
}
type Charged = { readonly chargedCents: number };

const keyOf = (h: Hook) => h.id;

describe("receive — first sighting of a key", () => {
  it("marks the key pending, enqueues the payload, and emits intake:process", () => {
    const intake = createIntake<Hook, Charged>({ keyOf });
    const s0 = intake.init();
    const payload: Hook = { id: "evt_1", amount: 5 };
    const [s1, cmds] = intake.receive(s0, payload, 0, "q1");

    // Cache: key now present and pending.
    expect(s1.seen.entries.evt_1?.value).toEqual({ phase: "pending" });
    // Queue: one pending item carrying the payload.
    expect(s1.queue).toHaveLength(1);
    expect(s1.queue[0]).toMatchObject({
      id: "q1",
      status: "pending",
      input: payload,
    });
    // Decision reified: process the new item.
    expect(cmds).toEqual([
      { type: "intake:process", key: "evt_1", itemId: "q1", payload },
    ]);
  });

  it("does not mutate the input slice", () => {
    const intake = createIntake<Hook, Charged>({ keyOf });
    const s0 = intake.init();
    const frozen = Object.freeze({
      seen: Object.freeze({ ...s0.seen }),
      queue: Object.freeze([...s0.queue]),
    }) as IntakeState<Hook, Charged>;
    intake.receive(frozen, { id: "evt_1", amount: 5 }, 0, "q1");
    expect(frozen.queue).toHaveLength(0);
    expect(Object.keys(frozen.seen.entries)).toHaveLength(0);
  });
});

describe("receive — duplicate while still pending", () => {
  it("drops silently: no enqueue, no Cmd, slice unchanged by reference fields", () => {
    const intake = createIntake<Hook, Charged>({ keyOf });
    const payload: Hook = { id: "evt_1", amount: 5 };
    const [s1] = intake.receive(intake.init(), payload, 0, "q1");
    // Same key arrives again before completion.
    const [s2, cmds] = intake.receive(s1, payload, 1, "q2");

    expect(cmds).toEqual([]); // dropped
    expect(s2).toBe(s1); // unchanged — no second queue item, no cache churn
    expect(s2.queue).toHaveLength(1);
  });
});

describe("receive — duplicate after completion", () => {
  it("replays the cached result instead of re-enqueuing", () => {
    const intake = createIntake<Hook, Charged>({ keyOf });
    const payload: Hook = { id: "evt_1", amount: 5 };
    const [s1] = intake.receive(intake.init(), payload, 0, "q1");
    const [s2] = intake.complete(s1, "evt_1", { chargedCents: 500 }, 10);
    // Webhook replayed after the work finished.
    const [s3, cmds] = intake.receive(s2, payload, 20, "q2");

    expect(cmds).toEqual([
      { type: "intake:replay", key: "evt_1", result: { chargedCents: 500 } },
    ]);
    // No new work: queue still holds only the original item.
    expect(s3.queue).toHaveLength(1);
    // Replay touches nothing.
    expect(s3).toBe(s2);
  });
});

describe("complete — swaps pending → done", () => {
  it("caches the result so the key reads back as done", () => {
    const intake = createIntake<Hook, Charged>({ keyOf });
    const [s1] = intake.receive(
      intake.init(),
      { id: "evt_1", amount: 5 },
      0,
      "q1",
    );
    expect(s1.seen.entries.evt_1?.value).toEqual({ phase: "pending" });

    const [s2, cmds] = intake.complete(s1, "evt_1", { chargedCents: 500 }, 10);
    expect(cmds).toEqual([]);
    expect(s2.seen.entries.evt_1?.value).toEqual({
      phase: "done",
      result: { chargedCents: 500 },
    });
    // complete owns the cache half only — the queue item is the host's to drain.
    expect(s2.queue).toEqual(s1.queue);
  });
});

describe("ttl expiry — a key replayed past the window is re-processed", () => {
  it("a completed key past ttlMs is treated as new on the next receive", () => {
    const intake = createIntake<Hook, Charged>({ keyOf, ttlMs: 1000 });
    const payload: Hook = { id: "evt_1", amount: 5 };
    const [s1] = intake.receive(intake.init(), payload, 0, "q1");
    const [s2] = intake.complete(s1, "evt_1", { chargedCents: 500 }, 0);

    // Inside the window — duplicate replays the cached result.
    const [, withinCmds] = intake.receive(s2, payload, 999, "q2");
    expect(withinCmds).toEqual([
      { type: "intake:replay", key: "evt_1", result: { chargedCents: 500 } },
    ]);

    // At/after ttlMs — the cached key has aged out; the payload is re-accepted.
    const [s4, pastCmds] = intake.receive(s2, payload, 1000, "q3");
    expect(pastCmds).toEqual([
      { type: "intake:process", key: "evt_1", itemId: "q3", payload },
    ]);
    expect(s4.queue).toHaveLength(2); // original + the re-accepted one
  });
});

describe("claimNext — the drain side", () => {
  it("claims the oldest pending item, flips it running, stamps startedAt", () => {
    const intake = createIntake<Hook, Charged>({ keyOf });
    let s = intake.init();
    [s] = intake.receive(s, { id: "a", amount: 1 }, 0, "q1");
    [s] = intake.receive(s, { id: "b", amount: 2 }, 1, "q2");

    const claim = intake.claimNext(s, 5);
    expect(claim).not.toBeNull();
    expect(claim?.claimed).toMatchObject({
      id: "q1",
      status: "running",
      startedAt: 5,
    });
    expect(claim?.state.queue[0]).toMatchObject({
      id: "q1",
      status: "running",
    });
  });

  it("returns null when nothing is pending", () => {
    const intake = createIntake<Hook, Charged>({ keyOf });
    expect(intake.claimNext(intake.init(), 0)).toBeNull();
  });
});

describe("boot — resume after eviction", () => {
  it("resets running items back to pending so a dead worker's claim is re-armed", () => {
    const intake = createIntake<Hook, Charged>({ keyOf });
    let s = intake.init();
    [s] = intake.receive(s, { id: "a", amount: 1 }, 0, "q1");
    // Worker claimed it, then the DO evicted before complete.
    const claim = intake.claimNext(s, 5);
    if (claim === null) throw new Error("expected a claimable item");
    expect(claim.state.queue[0]?.status).toBe("running");

    const [booted, cmds] = intake.boot(claim.state);
    expect(cmds).toEqual([]);
    expect(booted.queue[0]).toMatchObject({
      id: "q1",
      status: "pending",
      startedAt: undefined,
    });
    // The dedupe cache is left intact — the key is still pending in `seen`.
    expect(booted.seen.entries.a?.value).toEqual({ phase: "pending" });
  });

  it("is a no-op (same reference) when nothing is running", () => {
    const intake = createIntake<Hook, Charged>({ keyOf });
    const [s1] = intake.receive(intake.init(), { id: "a", amount: 1 }, 0, "q1");
    const [booted] = intake.boot(s1);
    expect(booted).toBe(s1);
  });

  it("a completed key still replays after boot", () => {
    const intake = createIntake<Hook, Charged>({ keyOf });
    const payload: Hook = { id: "a", amount: 1 };
    let s: IntakeState<Hook, Charged>;
    [s] = intake.receive(intake.init(), payload, 0, "q1");
    [s] = intake.complete(s, "a", { chargedCents: 100 }, 1);
    [s] = intake.boot(s);
    const [, cmds] = intake.receive(s, payload, 2, "q2");
    expect(cmds).toEqual([
      { type: "intake:replay", key: "a", result: { chargedCents: 100 } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Machine-level wiring: drop the verbs into a real `defineMachine` reducer and
// exercise them through the substrate's `replay` (via `bindMachine`). This is
// the integration the testing helpers are built for — it proves the verbs
// compose into a TEA machine and that the emitted Cmds survive `replay`.
// ---------------------------------------------------------------------------

type IntakeMsg =
  | {
      readonly type: "receive";
      readonly payload: Hook;
      readonly at: number;
      readonly id: string;
    }
  | {
      readonly type: "complete";
      readonly key: string;
      readonly result: Charged;
      readonly at: number;
    }
  | { readonly type: "boot" };

describe("machine wiring (replay through testing helpers)", () => {
  const intake = createIntake<Hook, Charged>({ keyOf });

  const machine = defineMachine<
    IntakeState<Hook, Charged>,
    IntakeMsg,
    IntakeCmd<Hook, Charged>,
    never,
    Record<string, never>
  >({
    init: (loaded) => [loaded ?? intake.init(), []],
    update: {
      receive: (s, m) => intake.receive(s, m.payload, m.at, m.id),
      complete: (s, m) => intake.complete(s, m.key, m.result, m.at),
      boot: (s) => intake.boot(s),
    },
  });

  const h = bindMachine(machine, {});

  it("emits intake:process for a fresh key", () => {
    const payload: Hook = { id: "evt_1", amount: 5 };
    h.expectCmdEmitted(
      { msgs: [{ type: "receive", payload, at: 0, id: "q1" }] },
      { type: "intake:process", key: "evt_1", itemId: "q1", payload },
    );
  });

  it("a receive→complete→receive sequence replays the cached result", () => {
    const payload: Hook = { id: "evt_1", amount: 5 };
    h.expectCmdSequence(
      {
        msgs: [
          { type: "receive", payload, at: 0, id: "q1" },
          {
            type: "complete",
            key: "evt_1",
            result: { chargedCents: 500 },
            at: 10,
          },
          { type: "receive", payload, at: 20, id: "q2" },
        ],
      },
      [
        { type: "intake:process", key: "evt_1", itemId: "q1", payload },
        { type: "intake:replay", key: "evt_1", result: { chargedCents: 500 } },
      ],
    );
  });

  it("rehydrates a persisted slice without emitting boot Cmds", () => {
    const payload: Hook = { id: "evt_1", amount: 5 };
    const [loaded] = intake.receive(intake.init(), payload, 0, "q1");
    // Replaying with a loaded snapshot and no msgs: init must be a pure
    // passthrough (no Cmds) — `replay` throws otherwise.
    h.expectFinalState({ msgs: [], loaded }, loaded);
  });
});

// ---------------------------------------------------------------------------
// Property: process-exactly-once. For ANY interleaving of receives over a
// small key alphabet, the number of `intake:process` Cmds emitted for a given
// key never exceeds the number of times that key's prior work was completed
// plus one (the original). With no TTL and no completes, each key is processed
// AT MOST ONCE no matter how many times it is received.
// ---------------------------------------------------------------------------

describe("property: a never-completed key is processed at most once", () => {
  it("holds for any sequence of receives over a small key alphabet", () => {
    const intake = createIntake<Hook, Charged>({ keyOf });

    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            key: fc.constantFrom("a", "b", "c", "d"),
            amount: fc.integer({ min: 0, max: 100 }),
            deltaMs: fc.integer({ min: 0, max: 100 }),
          }),
          { maxLength: 60 },
        ),
        (calls) => {
          let state = intake.init();
          let at = 0;
          let i = 0;
          const processCount = new Map<string, number>();

          for (const { key, amount, deltaMs } of calls) {
            at += deltaMs;
            const id = `q${i++}`;
            const [next, cmds] = intake.receive(
              state,
              { id: key, amount },
              at,
              id,
            );
            state = next;
            for (const cmd of cmds) {
              if (cmd.type === "intake:process") {
                processCount.set(cmd.key, (processCount.get(cmd.key) ?? 0) + 1);
              }
            }
          }

          // Never completed ⇒ each key processed at most once.
          for (const count of processCount.values()) {
            if (count > 1) return false;
          }
          // The queue holds exactly one item per distinct processed key.
          const distinctProcessed = processCount.size;
          return state.queue.length === distinctProcessed;
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property: a duplicate after completion replays the SAME result, every time,
// for any number of replays — the receive-once guarantee's payoff.
// ---------------------------------------------------------------------------

describe("property: post-completion duplicates always replay the original result", () => {
  it("every duplicate after complete emits exactly the cached result", () => {
    const intake = createIntake<Hook, Charged>({ keyOf });

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 1, max: 10 }),
        (chargedCents, replays) => {
          const payload: Hook = { id: "evt", amount: 1 };
          let state = intake.init();
          [state] = intake.receive(state, payload, 0, "q0");
          [state] = intake.complete(state, "evt", { chargedCents }, 1);

          for (let r = 0; r < replays; r++) {
            const [next, cmds] = intake.receive(
              state,
              payload,
              2 + r,
              `q${r + 1}`,
            );
            state = next; // replay leaves state unchanged, but thread it anyway
            // Bind the single Cmd, then narrow on its `type` discriminant: the
            // `intake:replay` arm is `IntakeReplayCmd<Charged>`, so `.result` is
            // `Charged` with no cast. (The inline `&&` chain lost the narrowing
            // across each re-index of `cmds[0]`, which is why a cast crept in.)
            const cmd = cmds[0];
            const ok =
              cmds.length === 1 &&
              cmd?.type === "intake:replay" &&
              cmd.result.chargedCents === chargedCents;
            if (!ok) return false;
          }
          // No re-enqueue across all the replays — queue stays at the one item.
          return state.queue.length === 1;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// DURABILITY (package-wide canon): every reachable TERMINAL slice of this knob
// round-trips through JSON unchanged. The slice is `{ seen, queue }` — a
// record-backed `IdempotencyStore<IntakeEntry<R>>` plus a `QueueItem<P>[]`. The
// "terminal" reachable shapes are the union of everything a verb sequence can
// land in: cache entries `{ phase: "pending" }` and `{ phase: "done", result }`
// (the done arm carries the consumer's `R`), and queue items in `pending` /
// `running`. If any verb ever introduced a `Map`, a closure, an `undefined`-
// valued field that JSON drops, or an `Error` object (whose stringify wipes to
// `{}`), this fails — exactly the defect the resilient-call sentinel guards.
//
// We drive a RANDOM interleaving of every state-shaping verb (receive /
// complete / claim / boot) over a small key alphabet with a TTL configured, so
// the walk reaches done entries, pending entries, aged-out (re-accepted)
// entries, and running queue items — then assert the full slice is JSON-stable.
// ---------------------------------------------------------------------------

describe("durability: every reachable terminal slice round-trips through JSON", () => {
  it("stringify → parse → deep-equals for any verb interleaving", () => {
    const intake = createIntake<Hook, Charged>({ keyOf, ttlMs: 1000 });

    type Step =
      | {
          readonly op: "receive";
          readonly key: string;
          readonly amount: number;
        }
      | {
          readonly op: "complete";
          readonly key: string;
          readonly cents: number;
        }
      | { readonly op: "claim" }
      | { readonly op: "boot" };

    const stepArb: fc.Arbitrary<Step> = fc.oneof(
      fc.record({
        op: fc.constant("receive" as const),
        key: fc.constantFrom("a", "b", "c"),
        amount: fc.integer({ min: 0, max: 100 }),
      }),
      fc.record({
        op: fc.constant("complete" as const),
        key: fc.constantFrom("a", "b", "c"),
        cents: fc.integer({ min: 0, max: 10_000 }),
      }),
      fc.record({ op: fc.constant("claim" as const) }),
      fc.record({ op: fc.constant("boot" as const) }),
    );

    fc.assert(
      fc.property(
        fc.array(stepArb, { maxLength: 50 }),
        fc.array(fc.integer({ min: 0, max: 200 }), {
          minLength: 50,
          maxLength: 50,
        }),
        (steps, deltas) => {
          let state: IntakeState<Hook, Charged> = intake.init();
          let at = 0;
          let i = 0;

          for (const step of steps) {
            at += deltas[i++] ?? 0;
            switch (step.op) {
              case "receive":
                [state] = intake.receive(
                  state,
                  { id: step.key, amount: step.amount },
                  at,
                  `q${i}`,
                );
                break;
              case "complete":
                [state] = intake.complete(
                  state,
                  step.key,
                  { chargedCents: step.cents },
                  at,
                );
                break;
              case "claim": {
                const claim = intake.claimNext(state, at);
                if (claim !== null) state = claim.state;
                break;
              }
              case "boot":
                [state] = intake.boot(state);
                break;
            }

            // The invariant holds at EVERY intermediate slice (each is itself a
            // reachable persisted snapshot), so assert inside the loop too —
            // a DO can evict between any two verbs.
            const roundTripped: IntakeState<Hook, Charged> = JSON.parse(
              JSON.stringify(state),
            );
            expect(roundTripped).toEqual(state);
          }

          // And the FINAL (terminal-of-this-walk) slice round-trips equal.
          const roundTripped: IntakeState<Hook, Charged> = JSON.parse(
            JSON.stringify(state),
          );
          expect(roundTripped).toEqual(state);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it("a done-cached slice carrying the result survives a JSON reload", () => {
    // The single most load-bearing terminal shape: a key resolved `done` whose
    // cached `result` (the consumer's `R`) must persist verbatim for replay.
    const intake = createIntake<Hook, Charged>({ keyOf });
    let s: IntakeState<Hook, Charged>;
    [s] = intake.receive(intake.init(), { id: "evt_1", amount: 5 }, 0, "q1");
    const claim = intake.claimNext(s, 1);
    if (claim !== null) s = claim.state;
    [s] = intake.complete(s, "evt_1", { chargedCents: 500 }, 2);

    // The done entry carries the result; the queue still holds the running item.
    expect(s.seen.entries.evt_1?.value).toEqual({
      phase: "done",
      result: { chargedCents: 500 },
    });
    const roundTripped: IntakeState<Hook, Charged> = JSON.parse(
      JSON.stringify(s),
    );
    expect(roundTripped).toEqual(s);
  });
});

// Sanity: the Cmd union is a proper `Cmd` (compile-time anchor — keeps the
// `Cmd` import load-bearing and documents the emitted-type shape at a glance).
const _processShape: IntakeCmd<Hook, Charged> & Cmd = {
  type: "intake:process",
  key: "k",
  itemId: "i",
  payload: { id: "k", amount: 0 },
};
void _processShape;
void noop;

// ===========================================================================
// WIRED MACHINE — the systemic root test this knob was missing.
//
// The replay-through-helpers block above hand-feeds Msgs and asserts the Cmds
// those exact Msgs emit. That is why both shipped bugs went green: nobody ran
// the REAL drain lifecycle end to end and asserted the END STATE.
//
// Here we build an actual `run()` Runtime from the knob's verbs and wire a
// worker into the `interpret` map that RE-ENTERS the bound machine: a fresh
// payload flows receive → (Cmd) intake:process → (follow-up Msg) claim →
// (Cmd) intake:work → worker runs, counts → (follow-up Msg) complete. The
// worker is the only thing that "does work", so its invocation count is the
// ground-truth "how many times did the side effect actually run" — the number
// the receive-once guarantee exists to bound.
//
// We then drive the two real scenarios the unit specs couldn't reach and
// assert the worker count + final queue, not the intermediate Msgs:
//
//   1. TTL ages a still-pending key  → a slow duplicate must NOT re-enqueue.
//   2. complete-then-crash + boot    → the completed item must NOT re-run.
//
// Both assertions FAIL against the pre-fix code and PASS after.
// ===========================================================================

// A queue-item id stamped onto each enqueue. Real hosts read crypto/Date at
// this boundary; the test injects a deterministic counter so the scenario is
// fully reproducible (and survives the "crash" with stable ids).
type WiredMsg =
  | {
      readonly type: "receive";
      readonly payload: Hook;
      readonly at: number;
      readonly id: string;
    }
  | { readonly type: "claim"; readonly at: number }
  | {
      readonly type: "work";
      readonly key: string;
      readonly payload: Hook;
      readonly at: number;
    }
  | {
      readonly type: "complete";
      readonly key: string;
      readonly result: Charged;
      readonly at: number;
    }
  | { readonly type: "boot" }
  | { readonly type: "nop" };

interface WorkCmd extends Cmd<"intake:work"> {
  readonly key: string;
  readonly payload: Hook;
}
type WiredCmd = IntakeCmd<Hook, Charged> | WorkCmd;

// ctx carries the worker's side-effect ledger: how many times each key was
// actually processed. This is the observable the guarantee is about.
interface WiredCtx {
  readonly processed: Map<string, number>;
  // The wall-clock the worker stamps onto `complete`. A box so the test can
  // advance it between phases without re-creating the machine.
  readonly clock: { value: number };
}

// In-memory store so a "crash" is just a fresh `run()` over the same bytes —
// the persisted slice is what the second runtime rehydrates.
function memStore<S>(): Store<S> & { snapshot(): S | null } {
  let cell: S | null = null;
  return {
    async load() {
      return cell;
    },
    async save(s: S) {
      cell = s;
    },
    // Trust the round-trip: the slice is the same shape we saved.
    migrate(raw: unknown) {
      return (raw as S | null) ?? null;
    },
    snapshot() {
      return cell;
    },
  };
}

function wiredMachine(intake: ReturnType<typeof createIntake<Hook, Charged>>) {
  return defineMachine<
    IntakeState<Hook, Charged>,
    WiredMsg,
    WiredCmd,
    never,
    WiredCtx
  >({
    init: (loaded) => [loaded ?? intake.init(), []],
    update: {
      receive: (s, m) => intake.receive(s, m.payload, m.at, m.id),
      // The drain: claim the next eligible item and tell the worker to run it.
      // claimNext is where the complete-then-crash fix lives — a done-keyed
      // item must be skipped here.
      claim: (s, m) => {
        const claimed = intake.claimNext(s, m.at);
        if (claimed === null) return [s, []];
        return [
          claimed.state,
          [
            {
              type: "intake:work",
              key: keyOf(claimed.claimed.input),
              payload: claimed.claimed.input,
            },
          ],
        ];
      },
      complete: (s, m) => intake.complete(s, m.key, m.result, m.at),
      boot: (s) => intake.boot(s),
      nop: (s) => [s, []],
    },
    interpret: {
      // A fresh key was accepted — kick the drain (re-enters via `claim`).
      "intake:process": async (cmd) =>
        ({ type: "claim", at: cmd.itemId.length }) as WiredMsg,
      // The worker. THE side effect. Counts the run, then re-enters via
      // `complete` to cache the result. This is the only place "work" happens.
      "intake:work": async (cmd, ctx) => {
        ctx.processed.set(cmd.key, (ctx.processed.get(cmd.key) ?? 0) + 1);
        return {
          type: "complete",
          key: cmd.key,
          result: { chargedCents: cmd.payload.amount * 100 },
          at: ctx.clock.value,
        } as WiredMsg;
      },
      // A duplicate after completion replays — the responder is a no-op here;
      // what matters is that the worker was NOT re-invoked (count unchanged).
      "intake:replay": async () => undefined,
    },
  });
}

// Drain the re-entrant follow-up chain. Each `await dispatch` settles only the
// transition it triggered; interpret follow-ups are scheduled on the tail.
// Pumping `nop` until the worker ledger stops moving flushes the whole chain.
async function settle(
  runtime: { dispatch(m: WiredMsg): Promise<void> },
  ctx: WiredCtx,
): Promise<void> {
  let prev = -1;
  let guard = 0;
  while (guard++ < 50) {
    const before = [...ctx.processed.values()].reduce((a, b) => a + b, 0);
    await runtime.dispatch({ type: "nop" });
    const after = [...ctx.processed.values()].reduce((a, b) => a + b, 0);
    if (after === before && after === prev) return;
    prev = after;
  }
}

describe("WIRED machine — end-to-end receive-once guarantee", () => {
  it("TTL ages a DONE key but NOT a still-pending one: a slow duplicate is not re-enqueued", async () => {
    // No auto-complete here — the worker is disabled so the first receive's
    // key stays PENDING for the whole test (simulating slow in-flight work).
    const intake = createIntake<Hook, Charged>({ keyOf, ttlMs: 1000 });
    const ctx: WiredCtx = { processed: new Map(), clock: { value: 0 } };
    const machine = defineMachine<
      IntakeState<Hook, Charged>,
      WiredMsg,
      WiredCmd,
      never,
      WiredCtx
    >({
      init: (loaded) => [loaded ?? intake.init(), []],
      update: {
        receive: (s, m) => intake.receive(s, m.payload, m.at, m.id),
        claim: (s, m) => {
          const claimed = intake.claimNext(s, m.at);
          if (claimed === null) return [s, []];
          return [
            claimed.state,
            [
              {
                type: "intake:work",
                key: keyOf(claimed.claimed.input),
                payload: claimed.claimed.input,
              },
            ],
          ];
        },
        complete: (s, m) => intake.complete(s, m.key, m.result, m.at),
        boot: (s) => intake.boot(s),
        nop: (s) => [s, []],
      },
      interpret: {
        // Worker disabled: the key stays pending forever. Count the *intent*
        // to process so the assertion can catch a double-enqueue.
        "intake:process": async (cmd, c) => {
          c.processed.set(cmd.key, (c.processed.get(cmd.key) ?? 0) + 1);
          return undefined;
        },
        "intake:work": async () => undefined,
        "intake:replay": async () => undefined,
      },
    });

    const runtime = await run(machine, { ctx }).ready;

    const payload: Hook = { id: "evt_1", amount: 5 };
    // First receive at t=0 → enqueued, worker "starts" (pending), never done.
    await runtime.dispatch({ type: "receive", payload, at: 0, id: "q1" });
    await settle(runtime, ctx);
    // Duplicate FAR past ttlMs (2000 > 1000) while the original is STILL in
    // flight. A correct intake never ages a pending key out.
    await runtime.dispatch({ type: "receive", payload, at: 2000, id: "q2" });
    await settle(runtime, ctx);

    // END STATE: exactly one queue item, the side effect attempted exactly
    // once. Pre-fix the pending key aged out → second enqueue → count 2.
    expect(runtime.getState().queue).toHaveLength(1);
    expect(ctx.processed.get("evt_1")).toBe(1);
    await runtime.stop();
  });

  it("complete-then-crash + boot: the completed item is NOT re-processed on resume", async () => {
    const intake = createIntake<Hook, Charged>({ keyOf });
    const store = memStore<IntakeState<Hook, Charged>>();
    const ctx: WiredCtx = { processed: new Map(), clock: { value: 10 } };

    // --- First boot: receive → claim → work (count 1) → complete. The queue
    // item is left RUNNING (host never reached markDone) but the key is DONE
    // in the cache. Then the DO evicts. ---
    const r1 = await run(wiredMachine(intake), { ctx, store }).ready;
    const payload: Hook = { id: "evt_1", amount: 5 };
    await r1.dispatch({ type: "receive", payload, at: 0, id: "q1" });
    await settle(r1, ctx);

    // Invariant after the first life: worker ran exactly once; the item is
    // still in the queue (never drained) and its key is cached done.
    expect(ctx.processed.get("evt_1")).toBe(1);
    const persisted = store.snapshot();
    if (persisted === null) throw new Error("expected a persisted slice");
    expect(persisted.queue).toHaveLength(1);
    expect(persisted.seen.entries.evt_1?.value).toEqual({
      phase: "done",
      result: { chargedCents: 500 },
    });
    await r1.stop();

    // --- CRASH + reboot from the SAME persisted bytes. The host dispatches a
    // `boot` Msg, then resumes the drain with `claim`. A correct intake must
    // skip the already-done item on BOTH paths → the worker never re-runs. ---
    const r2 = await run(wiredMachine(intake), { ctx, store }).ready;
    await r2.dispatch({ type: "boot" });
    await settle(r2, ctx);
    await r2.dispatch({ type: "claim", at: 100 }); // resume drain
    await settle(r2, ctx);

    // END STATE: the worker count is STILL 1. Pre-fix, boot re-armed the
    // running-but-done item to pending and the resumed drain re-claimed it →
    // the worker ran a second time → count 2.
    expect(ctx.processed.get("evt_1")).toBe(1);
    await r2.stop();
  });
});
