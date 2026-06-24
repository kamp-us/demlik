/**
 * `renderTimeline` (#raft ASCII timeline) — a deterministic projection of a
 * recorded `SimTrace`. Asserts the renderer is faithful + stable, and the final
 * `it` prints the canned failover timeline (the `demo:raft:viz` entry point —
 * the clean stdout an asciinema cast captures).
 *
 * Globals are NOT enabled in vitest.config.ts — describe/it/expect imported.
 */

import { describe, expect, it } from "vitest";
import { runDemo } from "./demo";
import { clusterConfigs, runSchedule } from "./sim";
import { renderTimeline } from "./timeline";

describe("renderTimeline — faithful projection of the trace", () => {
  it("renders the header, every node, and the failover story", () => {
    const text = renderTimeline(runDemo().trace);
    // Header + key.
    expect(text).toContain("@demlik/tea/raft — consensus timeline");
    expect(text).toContain("3 nodes, majority 2");
    expect(text).toContain("▸ leader");
    // Every node appears.
    for (const id of ["n0", "n1", "n2"]) expect(text).toContain(id);
    // The story: a leader is marked, the partition shows, term 2 is reached,
    // and the converged committed log [42, 77] is rendered.
    expect(text).toContain("▸ n0"); // n0 leads first (term 1)
    expect(text).toContain("partition · DOWN [n0]");
    expect(text).toContain("╳ n0"); // n0 marked down after the partition
    expect(text).toContain("(down)");
    expect(text).toContain("term 2"); // the new leader's term
    expect(text).toContain("[42, 77]"); // converged committed log
  });

  it("is deterministic — the same trace renders byte-identically", () => {
    const a = renderTimeline(runDemo().trace);
    const b = renderTimeline(runDemo().trace);
    expect(a).toBe(b);
  });

  it("noHeader drops the banner but keeps the step blocks", () => {
    const trace = runDemo().trace;
    const withHeader = renderTimeline(trace);
    const without = renderTimeline(trace, { noHeader: true });
    expect(withHeader).toContain("@demlik/tea/raft — consensus timeline");
    expect(without).not.toContain("@demlik/tea/raft — consensus timeline");
    expect(without).toContain("step "); // the steps are still there
  });

  it("works on an arbitrary author-supplied schedule (not just the demo)", () => {
    // A 5-node cluster, one election + drain — exercises the generic path.
    const trace = runSchedule(clusterConfigs(5), [
      { kind: "timer", node: "n0", timer: "election" },
      { kind: "settle", bound: 20 },
    ]);
    const text = renderTimeline(trace);
    expect(text).toContain("5 nodes, majority 3");
    expect(text).toContain("▸ n0"); // n0 wins the uncontested election
    for (const id of ["n0", "n1", "n2", "n3", "n4"]) expect(text).toContain(id);
  });
});

describe("raft ascii timeline — the recordable demo (demo:raft:viz)", () => {
  it("prints the failover timeline", () => {
    // This is the clean stdout an asciinema cast captures. The narration test in
    // demo.test.ts is the phase-level story; this is the per-step detail view.
    console.log(`\n${renderTimeline(runDemo().trace)}\n`);
    expect(true).toBe(true);
  });
});
