/**
 * Raft demo as an integration test (#123, stories 7+8). The runnable demo
 * (`./demo`) doubles as the acceptance test for the harness: it drives the full
 * consensus arc — elect → replicate+commit → KILL the leader → re-elect →
 * converge — over the deterministic simulation driver, and asserts each phase.
 *
 * Each `it` maps to a #123 acceptance criterion:
 *   - "a runnable demo elects a leader" ........... → "elects a leader (phase 1)"
 *   - "replicates ≥1 command to a majority" ....... → "commits a command (phase 2)"
 *   - "kills the leader, shows a new leader" ...... → "fails over to a NEW leader (phases 3–4)"
 *   - "logs converged" ............................ → "surviving majority converges (phase 5)"
 *   - "same schedule → same final cluster state" .. → "is byte-identically reproducible"
 *
 * Globals are NOT enabled in vitest.config.ts (describe/it/expect imported);
 * fast-check's seed is pinned by `src/test-setup.ts` for the reproducibility fuzz.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  committedCommands,
  demoCluster,
  demoIsReproducible,
  demoSchedule,
  narrateDemo,
  runDemo,
  survivors,
} from "./demo";
import { runSchedule } from "./sim";

describe("Raft demo — runnable elect → replicate → fail over → converge", () => {
  it("elects a leader (phase 1)", () => {
    const result = runDemo();
    // A single, well-defined leader emerged in term 1 before any failure.
    expect(result.firstLeader).not.toBeNull();
    const elect = result.phases[0];
    expect(elect?.leader).toBe(result.firstLeader);
    const leaderSummary = elect?.cluster.find(
      (n) => n.id === result.firstLeader,
    );
    expect(leaderSummary?.role).toBe("leader");
    expect(leaderSummary?.term).toBe(1);
  });

  it("replicates a command to a majority and commits it (phase 2)", () => {
    const result = runDemo();
    const phase = result.phases[1];
    const leader = phase?.cluster.find((n) => n.id === result.firstLeader);
    // The first client command is committed on the leader's log.
    expect(leader?.committed).toContain(42);
    expect(leader?.commitIndex).toBeGreaterThanOrEqual(1);
    // Committed means a MAJORITY (≥2 of 3) holds the entry in its committed log.
    const holders = phase?.cluster.filter((n) =>
      n.committed.includes(42),
    ).length;
    expect(holders ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("kills the leader and elects a NEW leader in a higher term (phases 3–4)", () => {
    const result = runDemo();
    // The killed node is partitioned; a different node now leads.
    expect(result.partitioned).toEqual(["n0"]);
    expect(result.secondLeader).not.toBeNull();
    expect(result.secondLeader).not.toBe(result.firstLeader);

    const before = result.phases[1]?.cluster.find(
      (n) => n.id === result.firstLeader,
    );
    const after = result.phases
      .at(-1)
      ?.cluster.find((n) => n.id === result.secondLeader);
    // The new leader's term is strictly higher than the dead leader's term.
    expect(after?.term).toBeGreaterThan(before?.term ?? 0);
    expect(after?.role).toBe("leader");
  });

  it("converges the committed log across the surviving majority (phase 5)", () => {
    const result = runDemo();
    const trace = result.trace;
    const alive = survivors(result.nodes, result.partitioned);

    // Both client commands are present and committed on the new leader.
    expect(result.convergedLog).toContain(42);
    expect(result.convergedLog).toContain(77);

    // Every SURVIVING node committed exactly the same prefix — they converged.
    for (const id of alive) {
      const state = trace.final[id];
      expect(state).toBeDefined();
      if (state) {
        expect(committedCommands(state)).toEqual(result.convergedLog);
      }
    }
  });

  it("never commits two different entries at the same index (state-machine safety)", () => {
    const result = runDemo();
    // Across EVERY node (survivors + the partitioned leader), no two nodes hold
    // a different committed command at the same log index.
    for (const step of result.trace.steps) {
      const byIndex = new Map<number, number>();
      for (const id of result.nodes) {
        const s = step.states[id];
        if (!s) continue;
        for (let i = 0; i < s.commitIndex; i++) {
          const cmd = s.log[i]?.command;
          if (cmd === undefined) continue;
          const seen = byIndex.get(i);
          if (seen === undefined) byIndex.set(i, cmd);
          else expect(cmd).toBe(seen);
        }
      }
    }
  });
});

describe("Raft demo — deterministic reproducibility", () => {
  it("is byte-identically reproducible (same schedule → same trace)", () => {
    const result = runDemo();
    expect(demoIsReproducible(result)).toBe(true);
  });

  it("two independent runs produce identical results", () => {
    const a = runDemo();
    const b = runDemo();
    expect(b.trace.final).toEqual(a.trace.final);
    expect(b.trace.steps).toEqual(a.trace.steps);
    expect(b.firstLeader).toEqual(a.firstLeader);
    expect(b.secondLeader).toEqual(a.secondLeader);
    expect(b.convergedLog).toEqual(a.convergedLog);
  });

  it("re-running the demo schedule on a fresh cluster is byte-identical", () => {
    // Drive the same schedule through the raw harness a handful of times under a
    // pinned-seed fast-check loop — every run agrees with the first (the replay
    // identity the safety suite leans on, here applied to the demo schedule).
    const configs = demoCluster();
    const schedule = demoSchedule();
    const baseline = runSchedule(configs, schedule);
    fc.assert(
      fc.property(fc.constant(null), () => {
        const again = runSchedule(configs, schedule);
        expect(again.final).toEqual(baseline.final);
        expect(again.steps).toEqual(baseline.steps);
      }),
    );
  });
});

describe("Raft demo — narration", () => {
  it("renders a readable narrative naming both leaders and the converged log", () => {
    const text = narrateDemo(runDemo());
    expect(text).toContain("multi-node consensus demo");
    // The narration surfaces the failover outcome explicitly.
    expect(text).toContain("failover: OK");
    expect(text).toMatch(/converged committed log:\s*\[42, 77\]/);
    // Print the live narration so running this file IS the runnable demo
    // (`pnpm --filter @demlik/tea demo:raft` runs exactly this test).
    console.log(`\n${text}\n`);
  });
});
