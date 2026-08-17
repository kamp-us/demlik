// ═══════════════════════════════════════════════════════════════════════════
// `end: "error"` is FINAL at runtime, not just in the types.
//
// `end` has two polarities — `true` (reached the goal) and `"error"` (stopped
// because it failed). The type layer's `IsEndOf` reads both, which is what
// exempts a final from the totality obligation and forbids it declaring edges.
//
// The runtime half read `node.end === true` in two places, so an error final
// silently lost both properties: it re-acquired the obligation (and threw
// `NoCellError` on an event scoped over it, instead of refusing), and it
// stopped drawing its `[*]` edge — reading, in the diagram, as a state the
// machine can leave.
//
// Neither had a test, which is exactly how it landed green. These are those
// tests, one per site, each asserting the two polarities behave identically.
// ═══════════════════════════════════════════════════════════════════════════
import { expect, it } from "vitest";
import { chartMermaid, compile } from "./compile";
import { defineChart, ty } from "./graph";

// `HALT` is scoped `"all"`, so it reaches the `done` phase — the case that
// distinguishes "final, therefore refused" from "undecided, therefore throws".
const ending = defineChart({
  ctx: ty<{ readonly n: number }>(),
  events: { GO: { scope: "working" }, HALT: { scope: "all" } },
  states: {
    working: { run: { initial: true, on: { GO: "won", HALT: "lost" } } },
    done: { won: { end: true }, lost: { end: "error" } },
  },
});

const table = compile(ending, {
  assign: { "run.GO": (s) => ({ n: s.n }), "run.HALT": (s) => ({ n: s.n }) },
});

it("an error final refuses a scoped event, exactly as a success final does", () => {
  const won = { type: "won", n: 1 } as const;
  const lost = { type: "lost", n: 1 } as const;
  // Refusal is a self-loop returning the SAME object — not a throw, and not a
  // rebuilt equal one.
  expect(table.won.HALT(won, { type: "HALT" })[0]).toBe(won);
  expect(table.lost.HALT(lost, { type: "HALT" })[0]).toBe(lost);
});

it("both polarities draw their terminal edge", () => {
  const drawn = chartMermaid(ending);
  expect(drawn).toContain("won --> [*]");
  expect(drawn).toContain("lost --> [*]");
});
