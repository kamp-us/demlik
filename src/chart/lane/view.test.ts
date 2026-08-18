// ═══════════════════════════════════════════════════════════════════════════
// `laneView` — the page's model, over the bytes fabrika actually wrote.
//
// The component's own tests (`react.test.tsx`) drive a real DOM and are the
// right place for anything about MARKUP. Everything here is a sentence the page
// says or a decision it makes, and both are decided in this file — pure, so a
// wrong answer is one assertion away rather than one query selector away.
//
// Every case below is a thing a reader saw on a rendered page and was misled
// by. They are grouped by what was wrong, not by which function is under test.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, expect, it } from "vitest";
import {
  REAL_CODER,
  REAL_EPIC,
  REAL_FROZEN,
} from "../report/__fixtures__/real";
import { parseEventsJsonl } from "../report/fold";
import { chartFromWorkflowText, type ImportedLane } from "../report/workflow";
import { coderParts, epic } from "./__fixtures__/epic-run";
import {
  type LaneTaskView,
  type LaneViewModel,
  laneView,
  liveFeed,
  replayFeed,
} from "./view";

/** The typed door's lane, as the runtime-typed value every derivation reads. */
const EPIC = epic as unknown as ImportedLane;

/** A leaf, as a running region carries one. */
type Leaf = Readonly<Record<string, unknown>> & { readonly type: string };

/**
 * A LIVE view over hand-placed regions.
 *
 * `liveFeed` asks its input two things — where the regions are after `n` msgs,
 * and what the tape holds — so a test that wants a lane standing somewhere
 * specific can just say where it is standing. No runtime, no clock, no
 * scheduling: the questions this file asks are about the MODEL.
 */
const liveAt = (
  regions: Readonly<Record<string, Leaf>>,
  msgs: readonly { readonly type: string }[] = [],
  lane: ImportedLane = EPIC,
): LaneViewModel =>
  laneView(
    liveFeed(lane, {
      regionsAt: () => regions,
      optsFor: () => ({ parts: coderParts as never }),
      msgs,
    }),
    msgs.length,
  );

const taskOf = (view: LaneViewModel, id: string): LaneTaskView =>
  view.phases
    .flatMap((p) => p.tasks)
    .find((t) => t.task === id) as LaneTaskView;

const outcomeOf = (view: LaneViewModel, id: string, event: string): string =>
  taskOf(view, id).controls.find((c) => c.event === event)?.outcome ?? "";

const laneOf = (real: typeof REAL_EPIC): ImportedLane =>
  chartFromWorkflowText(real.workflowJson);

const viewOf = (real: typeof REAL_EPIC, at?: number) => {
  const feed = replayFeed(laneOf(real), parseEventsJsonl(real.eventsJsonl));
  return laneView(feed, at ?? feed.total);
};

/** Every task the model asks the page to draw in full, lane-wide. */
const expandedIn = (view: ReturnType<typeof viewOf>): string[] =>
  view.phases.flatMap((p) => [...p.expanded]);

describe("the lane that ENDED still draws a diagram", () => {
  it("expands the phase a COMPLETE lane finished in", () => {
    // 5673 shipped. Before this, only an `active` or `tripped` phase expanded
    // anything — so a lane that ended the way lanes are supposed to end drew
    // zero diagrams, under a paragraph promising one under every task.
    const view = viewOf(REAL_CODER);
    expect(view.terminal).toBe("complete");
    expect(expandedIn(view)).toEqual(["issue"]);
  });

  it("expands the task that stopped a TRIPPED lane", () => {
    const view = viewOf(REAL_FROZEN);
    expect(view.terminal).toBe("tripped");
    expect(expandedIn(view)).toEqual(["issue"]);
  });

  it("leaves a finished phase folded while a LATER one is running", () => {
    // The rule that was right all along: phase1 of the epic is complete, and
    // its story is over — the reader came for phase2.
    const view = viewOf(REAL_EPIC);
    expect(view.phases[0]?.standing).toBe("complete");
    expect(view.phases[0]?.expanded).toEqual([]);
    expect(view.phases[1]?.expanded).toEqual(["issue_4240", "issue_4241"]);
  });
});

describe("why nothing can be dispatched is a fact of the SOURCE", () => {
  it("a replay lane states it, and states it on a FINISHED lane too", () => {
    // It used to be scraped back off the first non-refused control, and on a
    // finished lane the chart refuses every control — so the page dropped its
    // one explanation exactly where six dead buttons needed it.
    const view = viewOf(REAL_CODER);
    expect(
      view.phases.flatMap((p) => p.tasks).flatMap((t) => t.controls),
    ).toSatisfy((cs: { refused: boolean }[]) => cs.every((c) => c.refused));
    expect(view.noDispatch?.why).toContain("code bodies");
  });

  it("says it at every step of the scrubber, not only at the end", () => {
    expect(viewOf(REAL_EPIC, 0).noDispatch?.why).toContain("code bodies");
  });
});

describe("a refused msg is a step, and not a walk", () => {
  it("marks the tape entry the chart routed nowhere", () => {
    // A LIVE tape is where this happens: the chart is total, so a click on an
    // event this state does not route still records a msg, still counts as a
    // step and still gets a row — and rendered `build → build` it was
    // indistinguishable from a self-loop the chart actually declares.
    const lane = laneOf(REAL_CODER);
    const task = Object.keys(lane.charts)[0] as string;
    const leaf = (type: string) => ({ [task]: { type } });
    const view = laneView(
      liveFeed(lane, {
        // WIP moved it to `build`; PASS is not routed there, so the region did
        // not move — the same regions before and after.
        regionsAt: (n) => (n === 0 ? leaf("queued") : leaf("build")),
        msgs: [{ type: `${task}.WIP` }, { type: `${task}.PASS` }],
      }),
      2,
    );
    expect(view.steps.map((s) => [s.event, s.from, s.to, s.refused])).toEqual([
      ["WIP", "queued", "build", false],
      ["PASS", "build", "build", true],
    ]);
  });

  it("marks nothing on a replay, whose log could not hold one", () => {
    for (const real of [REAL_CODER, REAL_FROZEN, REAL_EPIC]) {
      expect(viewOf(real).steps.filter((s) => s.refused)).toEqual([]);
    }
  });
});

describe("the picture carries polarity, like every other surface", () => {
  it("lights an ERROR final apart from a healthy one", () => {
    const tripped = viewOf(REAL_FROZEN);
    const task = tripped.phases.flatMap((p) => p.tasks)[0];
    expect(task?.endPolarity).toBe("error");
    // the mechanism `stateDiagram-v2` has: a class on the node, since it has no
    // per-edge styling at all
    expect(task?.diagram).toContain("classDef teaActiveError");
    expect(task?.diagram).toContain(`class ${task?.state} teaActiveError`);

    const shipped = viewOf(REAL_CODER);
    const done = shipped.phases.flatMap((p) => p.tasks)[0];
    expect(done?.endPolarity).toBe(true);
    expect(done?.diagram).not.toContain("teaActiveError");
  });
});

describe("the cursor is a position in the run, and it is exact", () => {
  it("clamps a cursor nobody could have meant", () => {
    // A `<input type=range>` cannot produce these; a caller can, and `laneView`
    // is a public function long before it is a component's helper.
    const feed = replayFeed(
      laneOf(REAL_CODER),
      parseEventsJsonl(REAL_CODER.eventsJsonl),
    );
    expect(laneView(feed, 999).cursor).toBe(feed.total);
    expect(laneView(feed, 999).steps).toHaveLength(feed.total);
    expect(laneView(feed, -5).cursor).toBe(0);
    expect(laneView(feed, -5).steps).toEqual([]);
    expect(laneView(feed, -5).scrubbed).toBe(true);
  });

  it("shows the steps that HAVE happened, and not the one about to", () => {
    // `steps` and the leaves must agree about what "now" means: at cursor 3 the
    // page shows three rows and the state after the third. One `<` becoming
    // `<=` puts the table one step ahead of every chip above it.
    const feed = replayFeed(
      laneOf(REAL_CODER),
      parseEventsJsonl(REAL_CODER.eventsJsonl),
    );
    for (const at of [0, 1, 3, feed.total]) {
      const view = laneView(feed, at);
      expect(view.steps).toHaveLength(at);
      expect(view.steps.map((s) => s.index)).toEqual(
        [...Array(at).keys()].map((i) => i),
      );
    }
    // …and the third row's `to` IS the state the chips show at cursor 3
    const view = laneView(feed, 3);
    expect(taskOf(view, "issue").state).toBe(view.steps[2]?.to);
  });

  it("names the lane after the document when nobody passes a title", () => {
    const lane = laneOf(REAL_CODER);
    const feed = replayFeed(lane, []);
    expect(laneView(feed, 0).title).toBe(lane.id);
    expect(laneView(feed, 0, "my lane").title).toBe("my lane");
  });
});

describe("the diagram marks the path THIS task walked", () => {
  it("marks the walked edges, and only its own", () => {
    // `report.ts`'s `»` markers are pinned in markdown; on screen they were the
    // whole difference between "here is the machine" and "here is what
    // happened", and nothing checked them. Two ways to get it wrong: mark
    // nothing, or mark every task's steps on every task's picture.
    const view = viewOf(REAL_EPIC);
    const moved = taskOf(view, "issue_4240");
    const untouched = taskOf(view, "issue_4242");
    expect(moved.moved).toBe(true);
    expect(untouched.moved).toBe(false);
    expect(moved.diagram).toContain("WIP »");
    // …and the untouched task's picture is the same chart with nothing walked
    expect(untouched.diagram).not.toContain("»");
  });

  it("counts a repeated edge rather than drawing it once", () => {
    // 5674 took `DONE` three times. `×3` is the difference between a lane that
    // looped and a lane that walked a line.
    expect(taskOf(viewOf(REAL_FROZEN), "issue").diagram).toContain("×");
  });
});

describe("a live lane's regions are read as they actually are", () => {
  it("splits an addressed msg at the task the LANE declares", () => {
    // The address is split by matching the lane's own task ids rather than at
    // the first dot, so a task id holding one is not silently cut in half —
    // documented in `liveFeed`, unpinned until here.
    const chart = EPIC.charts.issue_1 as ImportedLane["charts"][string];
    const dotted: ImportedLane = {
      ...EPIC,
      phases: [{ name: "only", tasks: ["a.b"], onDone: undefined } as never],
      charts: { "a.b": chart },
      context: { "a.b": { maxRetries: 2, extras: {} } },
    };
    const view = liveAt(
      { "a.b": { type: "queued", retries: 0, maxRetries: 2 } },
      [{ type: "a.b.WIP" }],
      dotted,
    );
    expect(view.steps.map((s) => [s.task, s.event])).toEqual([["a.b", "WIP"]]);
  });

  it("keeps a parked region's resume target", () => {
    const view = liveAt({
      issue_1: { type: "blocked", retries: 0, maxRetries: 2, was: "review" },
      issue_2: { type: "queued", retries: 0, maxRetries: 2 },
      issue_3: { type: "queued", retries: 0, maxRetries: 5 },
    });
    expect(taskOf(view, "issue_1").was).toBe("review");
  });

  it("falls back to the LANE's retry budget when the leaf carries none", () => {
    // `issue_3` is the one on a longer leash (`retries: { issue_3: 5 }`), and a
    // running leaf that never took a retry has no `maxRetries` of its own.
    const view = liveAt({
      issue_1: { type: "queued", retries: 1 },
      issue_3: { type: "queued", retries: 1 },
    });
    expect(taskOf(view, "issue_3").budget).toEqual({
      retries: 1,
      maxRetries: 5,
    });
    expect(taskOf(view, "issue_1").budget).toEqual({
      retries: 1,
      maxRetries: 2,
    });
  });

  it("refuses to invent a retry budget for a chart that keeps none", () => {
    // `0/2` on a region whose state has no `retries` is a fact the page made
    // up. The honest answer is the reason it cannot say.
    const view = liveAt({ issue_1: { type: "queued" } });
    expect(taskOf(view, "issue_1").budget).toMatchObject({
      answerable: false,
      question: "retries",
    });
  });
});

/**
 * ONE GUARDED EDGE THAT FIRES A CMD — the two things a real lane cannot show.
 *
 * `ImportedEdge` has no `cmd` slot, so an imported lane carries none and
 * `defineLane`'s lowering drops the ones its charts declared (see
 * HANDOFF-ui.md); and `inspectLaneStates` hands a guard the leaf's `type`
 * alone, so a guard over the region's ctx cannot answer. This chart is written
 * around both: the guard reads the MSG, which does reach it, and the `cmd` is
 * declared the way `describeChart`'s reader reads one. What is under test is
 * how the outcome READS, and that is the same sentence either way.
 */
const GUARDED = {
  id: "guarded",
  phases: [{ name: "only", tasks: ["t"] }],
  terminals: { complete: "complete", tripped: "tripped" },
  context: { t: { maxRetries: 2, extras: {} } },
  charts: {
    t: {
      events: { GO: { scope: "edges" } },
      states: {
        main: {
          start: {
            initial: true,
            on: {
              GO: {
                target: "yes",
                when: "big",
                otherwise: "no",
                cmd: ["shout", "log"],
              },
            },
          },
          yes: { end: true },
          no: { end: "error" },
        },
      },
    },
  },
} as unknown as ImportedLane;

const guardedOutcome = (at: number): string =>
  outcomeOf(
    laneView(
      liveFeed(GUARDED, {
        regionsAt: () => ({ t: { type: "start" } }),
        msgs: [],
        optsFor: () => ({
          parts: {
            guards: { big: (_s: unknown, m: { at: number }) => m.at > 3 },
          } as never,
          samples: { GO: { at } } as never,
        }),
      }),
      0,
    ),
    "t",
    "GO",
  );

describe("what a control says it would do", () => {
  it("says which arm of a guard would fire, and which way round", () => {
    // The guarded arm's labelling has been wrong before, in two drawings, and
    // was fixed in one of them without the other moving. `[guard]` and
    // `[!guard]` are one character apart and opposite claims.
    expect(guardedOutcome(9)).toContain("→ yes [big]");
    expect(guardedOutcome(1)).toContain("→ no [!big]");
  });

  it("names the cmds the edge fires, after where it lands", () => {
    expect(guardedOutcome(9)).toBe("→ yes [big] / shout, log");
  });

  it("says WHY a guard could not be evaluated, not just that it wasn't", () => {
    // On an imported lane this is not a gap to fix — it is what an imported
    // lane IS, and `retriesRemaining? (no-guard-bag)` says neither.
    const outcome = outcomeOf(viewOf(REAL_FROZEN, 4), "issue", "FAIL");
    expect(outcome).toContain("workflow document");
    expect(outcome).not.toContain("threw");
  });

  it("carries the refusal's KIND, which is the page's CSS hook", () => {
    // Collapsing every refusal to `undeclared` loses the palette AND says the
    // chart's totality was bypassed, which is the loudest possible wrong
    // answer about a chart that refused the event on purpose.
    const ended = taskOf(viewOf(REAL_CODER), "issue");
    expect(new Set(ended.controls.map((c) => c.kind))).toEqual(
      new Set(["end"]),
    );
    const blocked = taskOf(viewOf(REAL_EPIC), "issue_4241");
    expect(blocked.state).toBe("blocked");
    expect(blocked.controls.find((c) => c.event === "WIP")?.kind).toBe(
      "no-edge",
    );
    expect(blocked.controls.find((c) => c.event === "UNBLOCKED")?.kind).toBe(
      "legal",
    );
  });
});

describe("which of twelve things is stuck names a PLACE too", () => {
  it("attaches the phase the stuck task lives in", () => {
    const view = viewOf(REAL_FROZEN);
    expect(view.stuck.map((s) => [s.task, s.phase, s.reason.kind])).toEqual([
      ["issue", "pipeline", "tripped"],
    ]);
  });
});

describe("a TRIPPED phase expands the task that stopped it", () => {
  it("expands the error final and not its shipped sibling", () => {
    // The distinction the `ending` rule cannot make on its own: both tasks
    // moved, and only one of them is why the reader is here.
    const view = liveAt({
      issue_1: { type: "shipped", retries: 0, maxRetries: 2 },
      issue_2: { type: "frozen", retries: 2, maxRetries: 2 },
    });
    expect(view.phases[0]?.standing).toBe("tripped");
    expect(view.phases[0]?.expanded).toEqual(["issue_2"]);
  });
});
