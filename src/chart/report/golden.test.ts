// ═══════════════════════════════════════════════════════════════════════════
// THE GOLDEN TEST — the importer, judged against fabrika's own compiler.
//
// This is the deliverable's backbone, and the reason is worth stating plainly:
// every OTHER test in this module asserts the importer against what THIS repo
// believes a `workflow.json` means. That belief is a copy, and a copy drifts.
//
// So the oracle is not a belief. `__fixtures__/vendor/fabrika-machine.ts` is
// `packages/fabrika-cli/src/lane/machine.ts`, vendored verbatim at a recorded
// commit and RUN HERE. Both sides are handed the same committed template, and
// the assertion is that they produce the same graph.
//
// READING THE EDGES OFF THE ORACLE. `topology()` answers, per state, the event
// NAMES a cell exists for — never the targets — which is exactly why `lane
// print` cannot be used to draw a lane. The targets live inside the compiled
// cells, so they are read the only way they can be: by EXECUTING each cell
// against probe states chosen to expose which of the three transition forms it
// is.
//
//   `was: PROBE` comes back as the target      → a resume (history) edge
//   `retries: 0` and `retries: max` disagree   → a guarded two-arm edge
//   otherwise                                  → a plain edge
//
// The one blind spot, named rather than hidden: a document with
// `maxRetries: 0` makes both guard arms take the fallthrough, so a guarded edge
// there would read as plain. Neither committed template is that document (both
// are 2), and `retry-budget.unit.test.ts` upstream fails closed if one becomes
// it.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, expect, it } from "vitest";
import { TEMPLATES } from "./__fixtures__/templates";
import {
  type CompiledTask,
  compile as fabrikaCompile,
  topology,
} from "./__fixtures__/vendor/fabrika-machine";
import { chartFromWorkflow, statesOf } from "./workflow";

const PROBE = "__probe_was__";

/** Every edge fabrika's COMPILED cells actually implement, in canonical form. */
function oracleEdges(task: CompiledTask): Map<string, string> {
  const table = task.machine.update as unknown as Record<
    string,
    Record<string, (s: unknown) => readonly [{ type: string }, unknown]>
  >;
  const max = task.initial.maxRetries;
  const out = new Map<string, string>();
  for (const [state, cells] of Object.entries(table)) {
    for (const [event, cell] of Object.entries(cells)) {
      const base = { type: state, retries: 0, maxRetries: max, was: PROBE };
      const fresh = cell(base)[0].type;
      const spent = cell({ ...base, retries: max })[0].type;
      if (fresh === PROBE) {
        // a resume: the fallback is what it lands on with no `was` to resume to.
        const fallback = cell({ type: state, retries: 0, maxRetries: max })[0]
          .type;
        out.set(`${state}|${event}`, `resume:${fallback}`);
      } else if (fresh !== spent) {
        out.set(`${state}|${event}`, `guard:${fresh}|else:${spent}`);
      } else {
        out.set(`${state}|${event}`, `to:${fresh}`);
      }
    }
  }
  return out;
}

/** The same canonical form, read declaratively off an imported chart. */
function chartEdges(chart: {
  states: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}): Map<string, string> {
  const out = new Map<string, string>();
  for (const [state, node] of statesOf(
    chart as Parameters<typeof statesOf>[0],
  )) {
    for (const [event, edge] of Object.entries(node.on ?? {})) {
      if ("resume" in edge) {
        out.set(`${state}|${event}`, `resume:${edge.resume.fallback}`);
      } else if ("when" in edge) {
        out.set(
          `${state}|${event}`,
          `guard:${edge.target}|else:${edge.otherwise}`,
        );
      } else {
        out.set(`${state}|${event}`, `to:${edge.target}`);
      }
    }
  }
  return out;
}

const sorted = (m: Map<string, string>): [string, string][] =>
  [...m.entries()].sort(([a], [b]) => a.localeCompare(b));

describe.each(TEMPLATES)("$name — imported vs fabrika's own compiler", ({
  document,
}) => {
  const compiled = fabrikaCompile(document);
  if (compiled._tag !== "Compiled") {
    throw new Error(
      `the vendored template no longer compiles upstream: ${compiled.defects.join("; ")}`,
    );
  }
  const oracle = compiled.lane;
  const topo = topology(oracle);
  const imported = chartFromWorkflow(document);

  it("agrees on the phase list and the two terminals", () => {
    expect(imported.phases).toEqual(
      topo.phases.map((p) => ({ name: p.name, tasks: [...p.tasks] })),
    );
    expect(imported.terminals).toEqual(topo.terminals);
    expect(imported.trigger).toEqual(topo.trigger);
  });

  it("agrees on which tasks exist", () => {
    expect(Object.keys(imported.charts).sort()).toEqual(
      Object.keys(topo.tasks).sort(),
    );
  });

  it.each(
    Object.keys(topo.tasks),
  )("task %s — the EDGE SET matches, target for target", (taskId) => {
    const task = oracle.tasks[taskId];
    const chart = imported.charts[taskId];
    if (task === undefined || chart === undefined) throw new Error("missing");
    expect(sorted(chartEdges(chart))).toEqual(sorted(oracleEdges(task)));
  });

  it.each(
    Object.keys(topo.tasks),
  )("task %s — the STATE SET matches, `hist` dropped by both", (taskId) => {
    const chart = imported.charts[taskId];
    const topoTask = topo.tasks[taskId];
    if (chart === undefined || topoTask === undefined) {
      throw new Error("missing");
    }
    expect([...statesOf(chart).keys()].sort()).toEqual(
      Object.keys(topoTask.states).sort(),
    );
    expect([...statesOf(chart).keys()]).not.toContain("hist");
  });

  it.each(
    Object.keys(topo.tasks),
  )("task %s — `topology()`'s per-state event names match one for one", (taskId) => {
    const chart = imported.charts[taskId];
    const topoTask = topo.tasks[taskId];
    if (chart === undefined || topoTask === undefined) {
      throw new Error("missing");
    }
    // The weaker assertion `lane print` could have supported, kept because it
    // is the one the CLI's own answer shape agrees with — if the edge-set
    // assertion above ever has to be relaxed, this one still holds the line.
    const mine = Object.fromEntries(
      [...statesOf(chart)].map(([state, node]) => [
        state,
        Object.keys(node.on ?? {}).sort(),
      ]),
    );
    const theirs = Object.fromEntries(
      Object.entries(topoTask.states).map(([state, events]) => [
        state,
        [...events].sort(),
      ]),
    );
    expect(mine).toEqual(theirs);
  });

  it.each(
    Object.keys(topo.tasks),
  )("task %s — the initial state and the retry budget match", (taskId) => {
    const chart = imported.charts[taskId];
    const topoTask = topo.tasks[taskId];
    if (chart === undefined || topoTask === undefined) {
      throw new Error("missing");
    }
    const initial = [...statesOf(chart)].filter(
      ([, node]) => node.initial === true,
    );
    expect(initial.map(([name]) => name)).toEqual([topoTask.initial]);
    expect(imported.context[taskId]?.maxRetries).toBe(topoTask.maxRetries);
  });

  it.each(
    Object.keys(topo.tasks),
  )("task %s — the FINALS and their POLARITY match `errorFinals`", (taskId) => {
    const task = oracle.tasks[taskId];
    const chart = imported.charts[taskId];
    if (task === undefined || chart === undefined) throw new Error("missing");
    const mineFinals: string[] = [];
    const mineErrors: string[] = [];
    for (const [state, node] of statesOf(chart)) {
      if (node.end !== undefined) mineFinals.push(state);
      if (node.end === "error") mineErrors.push(state);
    }
    expect(mineFinals.sort()).toEqual([...task.finals].sort());
    // THE POLARITY, which is the whole reason `end` widened: fabrika trips a
    // lane off `errorFinals`, and a chart that spelled every final `true`
    // could not tell the driver which of the two it reached.
    expect(mineErrors.sort()).toEqual([...task.errorFinals].sort());
    expect(mineErrors.length).toBeGreaterThan(0);
  });
});
