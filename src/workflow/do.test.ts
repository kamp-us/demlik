/**
 * `@demlik/tea/workflow/do` — a workflow as a durable DO grain (#126, child of
 * the durable-workflow epic #118).
 *
 * Four acceptance criteria, one suite (vitest globals are NOT enabled — import
 * describe/it/expect; fast-check seed + numRuns pinned by `src/test-setup.ts`):
 *
 *   1. **Persist-before-deliver across cold activations.** The workflow event
 *      log (the activity-result Msgs) persists through the durable store; the
 *      workflow advances across cold `/`-style activations with NO warm state
 *      between them — a fresh grain over the same bytes resumes from the durable
 *      checkpoint and completes.
 *   2. **Cold-wake re-emit, idempotent by delivery id.** On wake the grain
 *      replays its log and re-emits the owed-but-unconfirmed activity exactly
 *      once; a duplicate (already-folded) result arriving with a stale delivery
 *      id is a no-op at the reducer's id-match guard.
 *   3. **Evicted mid-activity resumes (replay byte-identity).** A workflow
 *      evicted mid-activity (its dispatch performed but result not yet folded)
 *      resumes and completes correctly; a re-woken grain's state equals the
 *      never-evicted grain after the same activity-result sequence (a fast-check
 *      property, the #124/#122 byte-identity model).
 *
 * Fakes mirror `../raft/do.test.ts`: an in-memory `DurableObjectStorage` whose
 * backing `Map` survives "eviction" (a fresh grain over the SAME bytes), plus a
 * recording activity performer. No live Workers runtime.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type ActivityCmd,
  type ActivityPerformer,
  type WorkflowGrainCtx,
  type WorkflowMsg,
  workflowGrain,
} from "./do";
import type { WorkflowStep } from "./index";

// The opaque workflow payloads. A three-step booking workflow: each step's
// activity is a label, each result is a string, each failure a string.
type Activity = string;
type Result = string;
type Failure = string;

const STEPS: readonly WorkflowStep<Activity>[] = [
  { name: "reserve-seat", activity: "reserve" },
  { name: "charge-card", activity: "charge" },
  { name: "issue-ticket", activity: "issue" },
];

// ── In-memory `DurableObjectStorage` fake (get/put/list). The backing Map is
// returned so a test can build a SECOND grain over the SAME bytes — the
// eviction/rehydrate simulation (the isolate dies, the storage survives). ────
function fakeStorage(backing: Map<string, string> = new Map()) {
  const storage = {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return backing.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      backing.set(key, value as unknown as string);
    },
    async list<T = unknown>(options?: {
      prefix?: string;
    }): Promise<Map<string, T>> {
      const prefix = options?.prefix ?? "";
      const out = new Map<string, T>();
      // Real DO list() returns keys in lexicographic order.
      for (const key of [...backing.keys()].sort()) {
        if (key.startsWith(prefix)) out.set(key, backing.get(key) as T);
      }
      return out;
    },
  };
  return { backing, storage: storage as unknown as DurableObjectStorage };
}

/**
 * A recording performer that succeeds every activity by echoing its label into
 * the result. Captures every Cmd it performed (for re-emit / dedup assertions).
 * `succeed` deterministically maps an activity → result, so a re-driven run
 * produces the SAME results (byte-identity).
 */
function recordingPerformer(
  map: (activity: Activity) => Result = (a) => `${a}-ok`,
): ActivityPerformer<Activity, Result, Failure> & {
  readonly performed: ActivityCmd<Activity>[];
} {
  const performed: ActivityCmd<Activity>[] = [];
  return {
    performed,
    async perform(cmd) {
      performed.push(cmd);
      return { type: "activity_ok", id: cmd.id, result: map(cmd.activity) };
    },
  };
}

/** Assemble a grain ctx over a backing Map, with a given performer. */
function grainCtx(
  backing: Map<string, string>,
  performer: ActivityPerformer<Activity, Result, Failure>,
): WorkflowGrainCtx<Activity, Result, Failure> {
  const { storage } = fakeStorage(backing);
  return { storage, performer };
}

// ===========================================================================
// Acceptance criterion 1 — the event log persists; advances across cold
// activations with no warm state between them
// ===========================================================================

describe("persist + advance across cold activations", () => {
  it("a fresh grain drives every step and reaches `completed`", async () => {
    const backing = new Map<string, string>();
    const performer = recordingPerformer();
    const grain = await workflowGrain(grainCtx(backing, performer), {
      steps: STEPS,
    });

    const final = await grain.drive();

    expect(final.status).toBe("completed");
    if (final.status !== "completed") throw new Error("unreachable");
    expect(final.output).toBe("issue-ok");
    expect(final.completed.map((c) => c.step.name)).toEqual([
      "reserve-seat",
      "charge-card",
      "issue-ticket",
    ]);
    // Each activity performed exactly once, in order.
    expect(performer.performed.map((c) => c.activity)).toEqual([
      "reserve",
      "charge",
      "issue",
    ]);
    await grain.close();
  });

  it("advances across cold activations with NO warm state between them", async () => {
    const backing = new Map<string, string>();

    // Model a hibernation between each activity result: each activation is a
    // BRAND-NEW grain over the SAME durable bytes (no warm state survives). The
    // performer drives exactly ONE owed activity then "evicts" (throws) before
    // the NEXT owed activity is performed — so each activation grows the durable
    // log by exactly one folded result, then the isolate dies. The next fresh
    // grain re-emits the next owed activity from the durable log.
    let activations = 0;
    let status = "running";
    let guard = 0;
    while (status === "running" && guard++ < 10) {
      // A performer that succeeds the FIRST activity it is handed this
      // activation, then evicts on the second — so one result lands per wake.
      let performedThisWake = 0;
      const oneShot: ActivityPerformer<Activity, Result, Failure> = {
        async perform(cmd) {
          performedThisWake++;
          if (performedThisWake > 1) throw new EvictBeforeResult(cmd);
          return {
            type: "activity_ok",
            id: cmd.id,
            result: `${cmd.activity}-ok`,
          };
        },
      };
      const grain = await workflowGrain(grainCtx(backing, oneShot), {
        steps: STEPS,
      });
      try {
        status = (await grain.drive()).status;
      } catch (e) {
        if (!(e instanceof EvictBeforeResult)) throw e;
        status = grain.state().status; // still running — evicted mid-flight
      }
      activations++;
      await grain.close();
    }

    // The workflow completed, and NO grain instance carried warm state into the
    // next: each was a fresh activation over the durable bytes.
    expect(status).toBe("completed");
    expect(activations).toBeGreaterThan(1);
    // The durable log holds the activity-result events (one per completed step).
    const logKeys = [...backing.keys()].filter((k) =>
      k.startsWith("@@es/evt/"),
    );
    expect(logKeys.length).toBe(STEPS.length);
  });
});

/** Marker thrown by a performer to simulate eviction before a result is folded. */
class EvictBeforeResult extends Error {
  constructor(readonly cmd: ActivityCmd<Activity>) {
    super(`evicted before result for activity ${cmd.activity}`);
  }
}

// ===========================================================================
// Acceptance criterion 2 — cold-wake re-emit, idempotent by delivery id
// ===========================================================================

describe("cold-wake re-emit (idempotent by delivery id)", () => {
  it("re-emits the owed-but-unconfirmed activity on wake, exactly once", async () => {
    const backing = new Map<string, string>();

    // First activation: perform the first activity but EVICT before its result
    // is folded (throw out of `drive`). The owe is on the ledger (persisted in
    // the boot snapshot path is not yet — but the owe lives in the fresh-boot
    // state, and the inbound-result log is still empty: the workflow is owed its
    // first activity and has recorded nothing). We assert the grain re-emits
    // that SAME owed activity on the next activation.
    const evicting: ActivityPerformer<Activity, Result, Failure> & {
      performed: ActivityCmd<Activity>[];
    } = {
      performed: [],
      async perform(cmd) {
        evicting.performed.push(cmd);
        throw new EvictBeforeResult(cmd);
      },
    };
    const g1 = await workflowGrain(grainCtx(backing, evicting), {
      steps: STEPS,
    });
    await expect(g1.drive()).rejects.toBeInstanceOf(EvictBeforeResult);
    // The first activity was attempted, owed but unconfirmed.
    expect(evicting.performed.map((c) => c.id)).toEqual([1]);
    await g1.close();

    // Cold wake: a fresh grain over the same bytes. It must re-emit the SAME
    // owed activity (delivery id 1) — and this time the performer succeeds, so
    // the workflow advances.
    const performer = recordingPerformer();
    const g2 = await workflowGrain(grainCtx(backing, performer), {
      steps: STEPS,
    });
    const final = await g2.drive();
    // The re-emitted dispatch carried the SAME delivery id the first owe minted.
    expect(performer.performed[0]?.id).toBe(1);
    expect(final.status).toBe("completed");
    await g2.close();
  });

  it("a duplicate (stale-id) result is a no-op at the reducer", async () => {
    const backing = new Map<string, string>();
    const performer = recordingPerformer();
    const grain = await workflowGrain(grainCtx(backing, performer), {
      steps: STEPS,
    });
    // Drive the first step to completion (folds result for delivery id 1,
    // advances to step 2 owing delivery id 2).
    const id1Result: WorkflowMsg<Result, Failure> = {
      type: "activity_ok",
      id: 1,
      result: "reserve-ok",
    };
    // Manually deliver the id-1 result first (the grain then performs step 2…).
    await grain.deliver(id1Result);
    const afterFirst = grain.state();
    // Re-deliver the SAME stale id-1 result: idempotent — state unchanged.
    const beforeDup = JSON.stringify(grain.state());
    await grain.deliver(id1Result);
    const afterDup = JSON.stringify(grain.state());
    expect(afterDup).toBe(beforeDup);
    // The workflow still made forward progress overall (it completed).
    expect(
      afterFirst.status === "completed" || afterFirst.status === "running",
    ).toBe(true);
    await grain.close();
  });
});

// ===========================================================================
// Acceptance criterion 3 — evicted mid-activity resumes (replay byte-identity)
// ===========================================================================

describe("cold-wake replay byte-identity", () => {
  // A workflow of 1..5 steps, each activity a distinct label; the performer
  // maps each activity → a deterministic result, so a re-driven run produces an
  // identical result schedule.
  const stepArb: fc.Arbitrary<readonly WorkflowStep<Activity>[]> = fc
    .array(fc.string({ minLength: 1, maxLength: 6 }), {
      minLength: 1,
      maxLength: 5,
    })
    .map((labels) =>
      labels.map((a, i) => ({ name: `step-${i}`, activity: a })),
    );

  it("a grain rebuilt from its persisted log equals the never-evicted grain", async () => {
    await fc.assert(
      fc.asyncProperty(stepArb, async (steps) => {
        const map = (a: Activity): Result => `${a}#done`;

        // Never-evicted: one long-lived grain drives the whole workflow.
        const backingLive = new Map<string, string>();
        const live = await workflowGrain(
          grainCtx(backingLive, recordingPerformer(map)),
          { steps },
        );
        const liveState = await live.drive();
        await live.close();

        // Cold wake: a brand-new grain over the SAME persisted bytes. Its
        // `load()` folds the log; no live result is delivered through `deliver`.
        const woken = await workflowGrain(
          grainCtx(backingLive, recordingPerformer(map)),
          { steps },
        );
        const wokenState = woken.state();
        await woken.close();

        // Byte-identity: the rebuilt state equals the never-evicted terminal
        // state — a pure function of the folded result-Msg log.
        expect(wokenState).toEqual(liveState);
      }),
    );
  });

  it("evicted mid-activity, the workflow resumes and completes correctly", async () => {
    const backing = new Map<string, string>();

    // Drive step 0 to a folded result (advances the durable log by one event),
    // then EVICT: step 1 is owed but its dispatch is interrupted.
    const evictAfterFirst: ActivityPerformer<Activity, Result, Failure> & {
      calls: number;
    } = {
      calls: 0,
      async perform(cmd) {
        evictAfterFirst.calls++;
        // Succeed step 0 (id 1); evict on step 1's dispatch (id 2).
        if (cmd.id === 1)
          return { type: "activity_ok", id: cmd.id, result: "reserve-ok" };
        throw new EvictBeforeResult(cmd);
      },
    };
    const g1 = await workflowGrain(grainCtx(backing, evictAfterFirst), {
      steps: STEPS,
    });
    await expect(g1.drive()).rejects.toBeInstanceOf(EvictBeforeResult);
    // step 0's result is durably folded; step 1 was attempted (owed id 2).
    const midState = g1.state();
    expect(midState.status).toBe("running");
    if (midState.status !== "running") throw new Error("unreachable");
    expect(midState.current.index).toBe(1);
    expect(midState.completed.map((c) => c.step.name)).toEqual([
      "reserve-seat",
    ]);
    await g1.close();

    // Cold wake: a fresh grain resumes from step 1's owed activity and a healthy
    // performer drives it to completion.
    const g2 = await workflowGrain(grainCtx(backing, recordingPerformer()), {
      steps: STEPS,
    });
    // The recovered state matches the mid-flight running state (step 1 owed).
    expect(g2.state()).toEqual(midState);
    const final = await g2.drive();
    expect(final.status).toBe("completed");
    if (final.status !== "completed") throw new Error("unreachable");
    expect(final.completed.map((c) => c.step.name)).toEqual([
      "reserve-seat",
      "charge-card",
      "issue-ticket",
    ]);
    await g2.close();
  });
});
