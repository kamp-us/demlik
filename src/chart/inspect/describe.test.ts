// ═══════════════════════════════════════════════════════════════════════════
// THE STATIC DESCRIPTION, ASSERTED AGAINST REAL CHARTS.
//
// `lane` is the grid form with a guard, a resume edge, phase-scoped events and
// two end states; `pollerChart` is the battery form, all cell edges. Between
// them every branch of `readEdge` and every refusal kind is exercised on a
// chart someone actually wrote, not a fixture invented to be easy.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, expect, it } from "vitest";
import { lane } from "../__fixtures__/lane";
import { fetchChart } from "../__fixtures__/resilient-fetch-chart";
import { pollerChart } from "../__fixtures__/status-poller-chart";
import { upload } from "../__fixtures__/upload";
import { watchdog } from "../__fixtures__/watchdog";
import {
  describeChart,
  edgeAt,
  explainRefusal,
  refusalAtState,
  stateInfo,
} from "./describe";

const laneDesc = describeChart(lane);
const pollDesc = describeChart(pollerChart);

describe("describeChart — the shape of the chart", () => {
  it("groups states into the phases the chart declares", () => {
    expect(laneDesc.phases).toEqual([
      { name: "working", states: ["queued", "build", "review", "ship"] },
      { name: "parked", states: ["blocked", "human:cp-approval"] },
      { name: "done", states: ["shipped", "frozen"] },
    ]);
  });

  it("reads the entry state off `initial: true` rather than being told", () => {
    expect(laneDesc.initial).toBe("queued");
    expect(pollDesc.initial).toBe("polling");
  });

  it("marks end states, parking states and their phases", () => {
    expect(stateInfo(laneDesc, "shipped")).toEqual({
      name: "shipped",
      phase: "done",
      initial: false,
      end: true,
      endPolarity: true,
      parking: false,
    });
    // `blocked` is parking because it carries a `resume` edge — a derivation
    // over the edges, not a flag on the node.
    expect(stateInfo(laneDesc, "blocked")?.parking).toBe(true);
    expect(stateInfo(laneDesc, "human:cp-approval")?.parking).toBe(true);
    expect(stateInfo(laneDesc, "queued")?.parking).toBe(false);
  });

  // BOTH POLARITIES ARE FINALS — the third runtime site that read `=== true`
  // (the two in `compile.ts` are pinned by `end-polarity.test.ts`). Described
  // as a non-final, `frozen` re-acquired the totality obligation, so an event
  // live over it came back `undeclared` — "the chart's totality was bypassed",
  // which is the loudest wrong answer the inspector can give.
  it("reads an error final as final, and refuses over it for that reason", () => {
    expect(stateInfo(laneDesc, "frozen")).toMatchObject({
      end: true,
      endPolarity: "error",
    });
    expect(stateInfo(laneDesc, "shipped")?.endPolarity).toBe(true);
    expect(stateInfo(laneDesc, "queued")?.endPolarity).toBe(false);
    expect(refusalAtState(laneDesc, "frozen", "WIP")).toEqual({
      kind: "end",
      state: "frozen",
    });
  });

  it("derives the event alphabet with each event's scope and payload flag", () => {
    expect(laneDesc.events).toEqual([
      { name: "WIP", scope: ["edges"], foreign: false, hasPayload: true },
      { name: "DONE", scope: ["edges"], foreign: false, hasPayload: true },
      { name: "BLOCKED", scope: ["working"], foreign: false, hasPayload: true },
      { name: "PASS", scope: ["edges"], foreign: false, hasPayload: true },
      { name: "FAIL", scope: ["edges"], foreign: false, hasPayload: true },
      {
        name: "UNBLOCKED",
        scope: ["parked"],
        foreign: false,
        hasPayload: true,
      },
    ]);
  });

  it("reads `foreign: true` off the event, not off a naming convention", () => {
    const desc = describeChart(watchdog);
    expect(desc.events.filter((e) => e.foreign).map((e) => e.name)).toEqual([
      "deadline_exceeded",
    ]);
  });

  it("`hasPayload` is false for an event that declared no `data`", () => {
    // `ty<T>()` is `{}` at runtime, so T is gone — but the `data` KEY survives
    // in the literal, which is exactly the fact "needs a sample".
    const desc = describeChart(upload);
    expect(desc.events.map((e) => [e.name, e.hasPayload] as const)).toEqual([
      ["pick", true],
      ["done", true],
      ["fail", true],
      ["ok", false],
    ]);
  });

  it("collects the guard and cell alphabets from the edges that reference them", () => {
    expect(laneDesc.guards).toEqual(["retriesRemaining"]);
    expect(laneDesc.cells).toEqual([]);
    expect(pollDesc.guards).toEqual([]);
    expect(pollDesc.cells).toEqual(["start", "tick", "onResult", "onError"]);
  });

  it("lists the declared cmd alphabet even for a cmd no edge fires", () => {
    // `read_status` is emitted only from inside a cell, so no edge names it —
    // and it is still part of the effect alphabet.
    expect(pollDesc.cmds).toEqual(["read_status"]);
    expect(laneDesc.cmds).toEqual([]);
  });
});

describe("describeChart — the edges", () => {
  it("reads a bare-string edge as a plain single-target transition", () => {
    expect(edgeAt(laneDesc, "queued", "WIP")).toEqual({
      from: "queued",
      event: "WIP",
      at: "queued.WIP",
      kind: "plain",
      targets: ["build"],
      cmds: [],
      otherwiseCmds: [],
    });
  });

  it("reads a guarded edge as both arms plus the guard name", () => {
    expect(edgeAt(laneDesc, "review", "FAIL")).toEqual({
      from: "review",
      event: "FAIL",
      at: "review.FAIL",
      kind: "guarded",
      targets: ["build", "frozen"],
      guard: "retriesRemaining",
      // biome-ignore lint/suspicious/noThenProperty: `then` is a guarded edge's HOLDS arm, mirroring the chart's `{ then, else }` assign shape — never a thenable
      then: "build",
      otherwise: "frozen",
      cmds: [],
      otherwiseCmds: [],
    });
  });

  it("reads a resume edge as its declared fallback", () => {
    expect(edgeAt(laneDesc, "blocked", "UNBLOCKED")).toEqual({
      from: "blocked",
      event: "UNBLOCKED",
      at: "blocked.UNBLOCKED",
      kind: "resume",
      targets: ["queued"],
      fallback: "queued",
      cmds: [],
      otherwiseCmds: [],
    });
  });

  it("reads a cell edge as its whole declared `to` fan-out", () => {
    expect(edgeAt(pollDesc, "polling", "poll_result")).toEqual({
      from: "polling",
      event: "poll_result",
      at: "polling.poll_result",
      kind: "cell",
      targets: ["polling", "done"],
      cell: "onResult",
      cmds: [],
      otherwiseCmds: [],
    });
  });

  it("carries an edge's cmd list, in declaration order, per guard arm", () => {
    const desc = describeChart(upload);
    // one cmd, as a bare string
    expect(edgeAt(desc, "idle", "pick")?.cmds).toEqual(["put_object"]);
    // an ORDERED list — the order is the firing order, so it is preserved
    expect(edgeAt(desc, "sending", "done")?.cmds).toEqual([
      "verify_object",
      "log",
    ]);
    // per-arm emission: which effects fire is a property of the BRANCH
    const guarded = edgeAt(desc, "sending", "fail");
    expect(guarded?.cmds).toEqual(["log"]);
    expect(guarded?.otherwiseCmds).toEqual(["log", "alert_human"]);
    // an edge with no `cmd` fires nothing
    expect(edgeAt(desc, "checking", "ok")?.cmds).toEqual([]);
    // and every name an edge fires is in the declared cmd alphabet
    for (const edge of desc.edges) {
      for (const cmd of [...edge.cmds, ...edge.otherwiseCmds]) {
        expect(desc.cmds).toContain(cmd);
      }
    }
  });

  it("every edge target is a state the chart declares", () => {
    const names = new Set(laneDesc.states.map((s) => s.name));
    for (const e of laneDesc.edges) {
      for (const t of e.targets) expect(names.has(t)).toBe(true);
    }
  });

  it("the site key `at` matches the key guards/cmds/cells are indexed by", () => {
    for (const e of laneDesc.edges) expect(e.at).toBe(`${e.from}.${e.event}`);
  });
});

describe("describeChart — refusals, the totality property as data", () => {
  it("refuses every event at an end state, by name", () => {
    for (const e of laneDesc.events) {
      expect(refusalAtState(laneDesc, "shipped", e.name)).toEqual({
        kind: "end",
        state: "shipped",
      });
    }
  });

  it("refuses an out-of-phase event with the scope that excluded it", () => {
    // BLOCKED is scoped to `working`; `blocked` lives in `parked`.
    expect(refusalAtState(laneDesc, "blocked", "BLOCKED")).toEqual({
      kind: "out-of-scope",
      scope: ["working"],
      phase: "parked",
    });
    // UNBLOCKED is scoped to `parked`; `queued` lives in `working`.
    expect(refusalAtState(laneDesc, "queued", "UNBLOCKED")).toEqual({
      kind: "out-of-scope",
      scope: ["parked"],
      phase: "working",
    });
  });

  it("refuses an `edges`-scoped event everywhere it is not routed", () => {
    expect(refusalAtState(laneDesc, "queued", "PASS")).toEqual({
      kind: "out-of-scope",
      scope: ["edges"],
      phase: "working",
    });
  });

  it("declared and refused PARTITION the whole (state × event) grid", () => {
    // The chart's central claim, checked: |S| × |M| = declared + refused,
    // with nothing in both and nothing in neither.
    const cells = laneDesc.states.length * laneDesc.events.length;
    expect(laneDesc.edges.length + laneDesc.refusals.length).toBe(cells);
    for (const r of laneDesc.refusals) {
      expect(edgeAt(laneDesc, r.from, r.event)).toBeUndefined();
    }
  });

  it("no refusal on a total chart is `undeclared`", () => {
    for (const desc of [laneDesc, pollDesc, describeChart(fetchChart)]) {
      for (const r of desc.refusals)
        expect(r.reason.kind).not.toBe("undeclared");
    }
  });

  it("refuses a live-but-ignored event as `ignored`, distinct from out-of-scope", () => {
    const desc = describeChart(watchdog);
    // `idle` is in phase `live`, and BOTH events are scoped to `live` — so they
    // ARE addressed here, and the state refuses them by name. A UI must be able
    // to tell that apart from "not routed to this phase".
    expect(refusalAtState(desc, "idle", "FINISHED")).toEqual({
      kind: "ignored",
      state: "idle",
    });
    expect(refusalAtState(desc, "idle", "deadline_exceeded")).toEqual({
      kind: "ignored",
      state: "idle",
    });
    // …while `START` is `edges`-scoped, so at `working` it is out of scope.
    expect(refusalAtState(desc, "working", "START")).toEqual({
      kind: "out-of-scope",
      scope: ["edges"],
      phase: "live",
    });
  });

  it("explainRefusal renders each kind as one readable line", () => {
    expect(explainRefusal("WIP", { kind: "end", state: "shipped" })).toContain(
      "end state",
    );
    expect(
      explainRefusal("BLOCKED", {
        kind: "out-of-scope",
        scope: ["working"],
        phase: "parked",
      }),
    ).toContain('phase "parked"');
    expect(explainRefusal("X", { kind: "ignored", state: "s" })).toContain(
      "`ignore`",
    );
    expect(explainRefusal("X", { kind: "undeclared" })).toContain("totality");
  });
});
