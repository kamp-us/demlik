// ═══════════════════════════════════════════════════════════════════════════
// `chartMermaid`'s OPTIONS — the drawing, told what to emphasise.
//
// `drawing.test.ts` pins the DEFAULT drawing in full, and that snapshot is the
// contract: every option here is additive, and the no-options call must keep
// producing the same bytes it always has. The first test in this file is that
// promise, stated as an assertion rather than as a comment.
//
// The rest exercise what the options add — a highlighted node, phases as real
// composite states (the one structural fact the flat drawing threw away), the
// two endings drawn apart, the walked edges marked, a title and a direction —
// and the sanitizing that makes `human:cp-approval` drawable at all.
// ═══════════════════════════════════════════════════════════════════════════
import { expect, it } from "vitest";
import { safeId } from "../machine-viz";
import { lane } from "./__fixtures__/lane";
import { pollerChart } from "./__fixtures__/status-poller-chart";
import { chartMermaid, edgeKey } from "./compile";

it("no options draws exactly what it drew before options existed", () => {
  // The bytes `drawing.test.ts` pins. Passing `{}` explicitly must not move
  // them either — an empty bag is not a different request.
  expect(chartMermaid(pollerChart, {})).toBe(chartMermaid(pollerChart));
  expect(chartMermaid(lane, {})).toBe(chartMermaid(lane));
  expect(
    chartMermaid(pollerChart).startsWith("stateDiagram-v2\n  direction TB"),
  ).toBe(true);
});

it("sanitizes a state name Mermaid cannot use as an identifier", () => {
  // `human:cp-approval` is a real lane state. Unsanitized, the `:` terminates
  // the transition label and the diagram is broken text.
  const drawn = chartMermaid(lane);
  expect(safeId("human:cp-approval")).toBe("human_cp_approval");
  expect(drawn).toContain("ship --> human_cp_approval : BLOCKED");
  // …and the human name survives as the node's label, once.
  expect(drawn).toContain("human_cp_approval : human cp-approval");
  expect(drawn.split("human_cp_approval : human cp-approval").length).toBe(2);
});

it("draws the whole lane chart, phases and all", () => {
  expect(
    chartMermaid(lane, {
      title: "lane",
      direction: "LR",
      phases: true,
      highlight: "review",
    }),
  ).toMatchInlineSnapshot(`
    "---
    title: lane
    ---
    stateDiagram-v2
      direction LR
      state working {
        queued
        build
        review
        ship
      }
      state parked {
        blocked
        human_cp_approval : human cp-approval
      }
      state done {
        shipped
        frozen
      }
      [*] --> queued
      queued --> build : WIP
      queued --> blocked : BLOCKED
      build --> review : DONE
      build --> blocked : BLOCKED
      review --> ship : PASS
      review --> blocked : BLOCKED
      review --> build : FAIL [retriesRemaining]
      review --> frozen : FAIL [!retriesRemaining]
      ship --> shipped : DONE
      ship --> human_cp_approval : BLOCKED
      blocked --> queued : UNBLOCKED (resume)
      human_cp_approval --> queued : UNBLOCKED (resume)
      shipped --> [*]
      frozen --> [*]
      classDef teaActive fill:#2f81f7,stroke:#2f81f7,color:#fff,font-weight:bold
      class review teaActive"
  `);
});

it("highlights the active node, and only when the chart has it", () => {
  const lit = chartMermaid(lane, { highlight: "build" });
  expect(lit).toContain("class build teaActive");
  expect(lit).toContain("classDef teaActive");
  // a name that is not a state draws no phantom node and no dangling class
  const bogus = chartMermaid(lane, { highlight: "nowhere" });
  expect(bogus).toBe(chartMermaid(lane));
});

it("the highlight follows the state, which is what makes it a live diagram", () => {
  for (const s of ["queued", "build", "review", "ship"]) {
    expect(chartMermaid(lane, { highlight: s })).toContain(
      `class ${s} teaActive`,
    );
  }
});

it("phases wrap every declared state, including one with no edges", () => {
  const drawn = chartMermaid(lane, { phases: true });
  for (const [phase, members] of [
    ["working", ["queued", "build", "review", "ship"]],
    ["parked", ["blocked", "human_cp_approval"]],
    ["done", ["shipped", "frozen"]],
  ] as const) {
    expect(drawn).toContain(`  state ${phase} {`);
    for (const m of members) expect(drawn).toContain(m);
  }
  // `shipped`/`frozen` have no outgoing edges, so the FLAT drawing mentions
  // them only as arrow targets. In phase mode they are declared members.
  expect(drawn).toContain("    shipped");
  expect(drawn).toContain("    frozen");
});

it("phases do not change which EDGES are drawn — only where nodes live", () => {
  const flat = chartMermaid(lane);
  const grouped = chartMermaid(lane, { phases: true });
  const arrows = (s: string) =>
    s.split("\n").filter((l) => l.includes(" --> "));
  expect(arrows(grouped)).toEqual(arrows(flat));
});

it("carries a title as Mermaid front matter, and the direction as asked", () => {
  const drawn = chartMermaid(pollerChart, {
    title: "status poller",
    direction: "LR",
  });
  expect(drawn.split("\n").slice(0, 5)).toEqual([
    "---",
    "title: status poller",
    "---",
    "stateDiagram-v2",
    "  direction LR",
  ]);
});

it("labels BOTH arms of a guarded edge — a bare then-arm reads as unconditional", () => {
  const drawn = chartMermaid(lane);
  // `FAIL` from `review` is one guarded edge with two arms. Drawing the
  // then-arm bare beside a `[!guard]` else-arm made the guard look like it
  // applied to one of them.
  expect(drawn).toContain("review --> build : FAIL [retriesRemaining]");
  expect(drawn).toContain("review --> frozen : FAIL [!retriesRemaining]");
});

it("polarity draws the two endings apart, and only the ones that exist", () => {
  const drawn = chartMermaid(lane, { polarity: true });
  // `frozen` is the `end: "error"` final, `shipped` the `end: true` one — both
  // terminate, and a picture that painted them alike would be lying where a
  // reader looks first.
  expect(drawn).toContain("classDef teaTripped stroke-dasharray:4 4");
  expect(drawn).toContain("class frozen teaTripped");
  expect(drawn).toContain("classDef teaShipped stroke-width:2px");
  expect(drawn).toContain("class shipped teaShipped");
  // …and a chart with no error final gets no dangling classDef for one.
  const poller = chartMermaid(pollerChart, { polarity: true });
  expect(poller).not.toContain("teaTripped");
});

it("marks a walked edge on its LABEL — mermaid has no per-edge styling", () => {
  const walked = new Map([
    [edgeKey("review", "FAIL", "build"), 2],
    [edgeKey("blocked", "UNBLOCKED", "queued"), 1],
  ]);
  const drawn = chartMermaid(lane, { walked });
  expect(drawn).toContain("review --> build : FAIL [retriesRemaining] »×2");
  expect(drawn).toContain("blocked --> queued : UNBLOCKED (resume) »");
  // An edge the walk never took is untouched, and an empty walk is no walk.
  expect(drawn).toContain("queued --> blocked : BLOCKED\n");
  expect(chartMermaid(lane, { walked: new Map() })).toBe(chartMermaid(lane));
});
