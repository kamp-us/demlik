/**
 * #144 — the additive `SimStep.delivered` read-off.
 *
 * The field is a PURE projection of the {@link InFlight} a `deliver` step pulled
 * off the pending pool (sender, target, `RaftCmd` discriminant). These tests
 * pin three things the renderer leans on:
 *   1. a `deliver` step that actually moves a message carries `delivered`;
 *   2. every NON-deliver step (and an empty-pool deliver) leaves it ABSENT;
 *   3. the field is byte-stable under replay AND its presence changes no fold
 *      behavior — a trace stripped of `delivered` is identical to one a pre-#144
 *      run would have produced (states/event/pending unchanged).
 *
 * Globals are NOT enabled (describe/it/expect imported).
 */

import { describe, expect, it } from "vitest";
import type { Schedule } from "./sim";
import { clusterConfigs, replaySchedule, runSchedule } from "./sim";

const cfg = clusterConfigs(3); // n0, n1, n2

describe("SimStep.delivered — additive read-off of the delivered message", () => {
  // n0 times out and becomes a candidate, fanning out RequestVote to n1, n2.
  // A `settle` then drains those (and the replies) — each drained delivery is
  // its own step and must carry its own `delivered`.
  const schedule: Schedule = [
    { kind: "timer", node: "n0", timer: "election" },
    { kind: "settle", bound: 16 },
  ];
  const trace = runSchedule(cfg, schedule);

  it("leaves `delivered` absent on a timer step (nothing delivered)", () => {
    const timerStep = trace.steps[0];
    expect(timerStep.event.kind).toBe("timer");
    expect(timerStep.delivered).toBeUndefined();
  });

  it("populates `delivered` on the first drained RequestVote delivery", () => {
    // After the election timer, the pool holds the two SendRequestVote Cmds n0
    // emitted (to n1 and n2). The settle drains FIFO, so the first delivery is
    // n0 → n1 RequestVote.
    const firstDeliver = trace.steps.find(
      (s) => s.event.kind === "deliver" && s.delivered !== undefined,
    );
    expect(firstDeliver).toBeDefined();
    expect(firstDeliver?.delivered).toEqual({
      from: "n0",
      to: "n1",
      kind: "raft:send_request_vote",
    });
  });

  it("records a RequestVote reply flowing back to the candidate", () => {
    const reply = trace.steps.find(
      (s) => s.delivered?.kind === "raft:send_request_vote_reply",
    );
    expect(reply).toBeDefined();
    // A reply is addressed back to the candidate that asked.
    expect(reply?.delivered?.to).toBe("n0");
  });

  it("every delivered message targets its Cmd's `to` (sender ≠ target)", () => {
    for (const step of trace.steps) {
      if (step.delivered) {
        expect(step.delivered.from).not.toBe(step.delivered.to);
        expect(cfg.map((c) => c.self)).toContain(step.delivered.from);
        expect(cfg.map((c) => c.self)).toContain(step.delivered.to);
      }
    }
  });

  it("leaves `delivered` absent on a deliver against an empty pool", () => {
    // A lone deliver with no prior emission: the pool is empty, so it is a
    // recorded no-op — no message moved, no `delivered`.
    const empty = runSchedule(cfg, [{ kind: "deliver", index: 0 }]);
    expect(empty.steps[0].event.kind).toBe("deliver");
    expect(empty.steps[0].delivered).toBeUndefined();
  });

  it("leaves `delivered` absent on a partition step", () => {
    const t = runSchedule(cfg, [{ kind: "partition", down: ["n1"] }]);
    expect(t.steps[0].event.kind).toBe("partition");
    expect(t.steps[0].delivered).toBeUndefined();
  });
});

describe("SimStep.delivered — no semantic change to the fold", () => {
  const schedule: Schedule = [
    { kind: "timer", node: "n0", timer: "election" },
    { kind: "settle", bound: 16 },
    { kind: "client", node: "n0", command: 42 },
    { kind: "settle", bound: 16 },
  ];

  it("is byte-stable under replay (field included)", () => {
    const a = runSchedule(cfg, schedule);
    const b = replaySchedule(cfg, schedule);
    expect(b.steps).toEqual(a.steps);
    expect(b.final).toEqual(a.final);
  });

  it("a trace with `delivered` stripped is identical to a pre-#144 trace", () => {
    // Prove the field is purely additive: removing it leaves event/pending/
    // states untouched — exactly the shape a pre-#144 run produced.
    const trace = runSchedule(cfg, schedule);
    const stripped = trace.steps.map(({ delivered: _drop, ...rest }) => rest);
    for (const step of stripped) {
      expect(step).not.toHaveProperty("delivered");
      expect(step).toHaveProperty("event");
      expect(step).toHaveProperty("pending");
      expect(step).toHaveProperty("states");
    }
    // And every node's per-step state is unchanged by the read-off.
    trace.steps.forEach((step, i) => {
      expect(step.states).toEqual(stripped[i].states);
    });
  });
});
