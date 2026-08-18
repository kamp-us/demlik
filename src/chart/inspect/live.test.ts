// ═══════════════════════════════════════════════════════════════════════════
// THE LIVE LAYER — legality, refusal reasons, the guard preview, cell resolution.
//
// Two claims are load-bearing here and both are asserted against the REAL
// parts bags the fixtures already ship (never a stub written to be easy):
//
//   1. the guard preview AGREES WITH THE MACHINE. For every state/event where
//      it says `then`, compiling the chart and folding that msg lands on the
//      `then` target — asserted by driving `replay`, not by re-reading the
//      chart. A preview that could disagree with the runtime is worse than no
//      preview.
//   2. it degrades HONESTLY. No sample, no bag, a throwing body → `unknown`
//      plus the reason. Never a guess, never a silent `else`.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, expect, it } from "vitest";
import { replay } from "../../index";
import type { Sub } from "../../pure/core";
import { defineMachine } from "../../runtime-types";
import {
  type LaneCmd,
  type LaneMsg,
  type LaneState,
  lane,
  assign as laneAssign,
  guards as laneGuards,
} from "../__fixtures__/lane";
import {
  type PollState,
  cells as pollCells,
  pollerChart,
} from "../__fixtures__/status-poller-chart";
import { uCmds, upload } from "../__fixtures__/upload";
import { watchdog } from "../__fixtures__/watchdog";
import { compile, initFrom } from "../compile";
import { describeChart } from "./describe";
import { inspectState, inspectStateSummary, previewEvent } from "./live";
import type { Samples } from "./samples";

const laneDesc = describeChart(lane);
const laneParts = { guards: laneGuards };

// The samples bag, typed BY the chart: every lane event declares a payload, so
// every key is REQUIRED here and each value is exactly its declared shape.
const laneSamples: Samples<typeof lane> = {
  WIP: { at: 1 },
  DONE: { at: 2 },
  BLOCKED: { at: 3, reason: "waiting on review" },
  PASS: { at: 4 },
  FAIL: { at: 5, reason: "flaky" },
  UNBLOCKED: { at: 6 },
};

const review = (retries: number, maxRetries: number): LaneState =>
  ({ type: "review", retries, maxRetries }) as LaneState;

describe("inspectState — the button row builds itself", () => {
  it("returns one verdict per declared event, in chart order", () => {
    const verdicts = inspectState(laneDesc, review(0, 3), {
      parts: laneParts,
      samples: laneSamples,
    });
    expect(verdicts.map((v) => v.event)).toEqual([
      "WIP",
      "DONE",
      "BLOCKED",
      "PASS",
      "FAIL",
      "UNBLOCKED",
    ]);
  });

  it("splits legal from refused without dropping either", () => {
    const s = inspectStateSummary(laneDesc, review(0, 3), {
      parts: laneParts,
      samples: laneSamples,
    });
    expect(s.legal).toEqual(["BLOCKED", "PASS", "FAIL"]);
    expect(s.refused).toEqual(["WIP", "DONE", "UNBLOCKED"]);
    expect(s.events.length).toBe(s.legal.length + s.refused.length);
  });

  it("a refused event is a verdict WITH a reason, not an absent entry", () => {
    const v = previewEvent(laneDesc, review(0, 3), "WIP", {});
    expect(v.status).toBe("refused");
    expect(v.reason).toEqual({
      kind: "out-of-scope",
      scope: ["edges"],
      phase: "working",
    });
    expect(v.why).toContain("not addressed to phase");
    expect(v.edge).toBeUndefined();
  });

  it("an end state refuses everything, and says which state ended", () => {
    const shipped = { type: "shipped", retries: 0, maxRetries: 3 } as LaneState;
    const s = inspectStateSummary(laneDesc, shipped, { samples: laneSamples });
    expect(s.legal).toEqual([]);
    expect(s.refused.length).toBe(laneDesc.events.length);
    for (const v of s.events) {
      expect(v.reason).toEqual({ kind: "end", state: "shipped" });
    }
  });

  it("distinguishes ignored-here from not-addressed-here", () => {
    const wDesc = describeChart(watchdog);
    const idle = { type: "idle", jobId: "j", deadlineAtMs: 0 };
    const byName = previewEvent(wDesc, idle, "FINISHED");
    expect(byName.reason?.kind).toBe("ignored");
    const working = { type: "working", jobId: "j", deadlineAtMs: 0 };
    expect(previewEvent(wDesc, working, "START").reason?.kind).toBe(
      "out-of-scope",
    );
  });
});

describe("previewEvent — what would fire, and where it would land", () => {
  it("resolves a plain edge's single target with no parts at all", () => {
    const queued = { type: "queued", retries: 0, maxRetries: 3 } as LaneState;
    const v = previewEvent(laneDesc, queued, "WIP");
    expect(v.status).toBe("legal");
    expect(v.targets).toEqual(["build"]);
    expect(v.resolved).toBe("build");
    expect(v.resolvedBy).toBe("declared");
  });

  it("reports the cmds an edge would fire, per guard arm", () => {
    const uDesc = describeChart(upload);
    const sending = { type: "sending", key: "k", tries: 0 };
    const parts = {
      guards: { hasBudget: (s: { tries: number }) => s.tries < 3 },
    };
    const samples: Samples<typeof upload> = {
      pick: { key: "k" },
      done: { etag: "e" },
      fail: { error: "boom" },
    };
    const held = previewEvent(uDesc, sending, "fail", { parts, samples });
    expect(held.guard?.branch).toBe("then");
    expect(held.cmds).toEqual(["log"]);
    expect(held.resolved).toBe("idle");

    const spent = previewEvent(uDesc, { ...sending, tries: 9 }, "fail", {
      parts,
      samples,
    });
    expect(spent.guard?.branch).toBe("else");
    expect(spent.cmds).toEqual(["log", "alert_human"]);
    expect(spent.resolved).toBe("dead");
    // `uCmds` is the real builder bag — the preview names cmds it can build.
    for (const c of spent.cmds) expect(uCmds).toHaveProperty(c);
  });

  it("resolves a resume edge off the live `was`, and falls back when absent", () => {
    const parked = {
      type: "blocked",
      was: "review",
      retries: 1,
      maxRetries: 3,
    } as LaneState;
    const v = previewEvent(laneDesc, parked, "UNBLOCKED", {
      samples: laneSamples,
    });
    expect(v.resolved).toBe("review");
    expect(v.resolvedBy).toBe("resume");
    expect(v.targets).toEqual(["review"]);

    // `was` is compiler-injected, so this shape is only reachable by hand — the
    // preview still answers, with the DECLARED fallback.
    const noWas = { type: "blocked", retries: 1, maxRetries: 3 };
    const f = previewEvent(laneDesc, noWas, "UNBLOCKED", {
      samples: laneSamples,
    });
    expect(f.resolved).toBe("queued");
    expect(f.targets).toEqual(["queued"]);
  });
});

describe("the guard preview — the capability no other inspector has", () => {
  it("says `then` when the guard holds, with that arm's target", () => {
    const v = previewEvent(laneDesc, review(0, 3), "FAIL", {
      parts: laneParts,
      samples: laneSamples,
    });
    expect(v.guard).toEqual({
      guard: "retriesRemaining",
      branch: "then",
      target: "build",
      cmds: [],
    });
    expect(v.resolved).toBe("build");
    expect(v.resolvedBy).toBe("guard");
  });

  it("says `else` when the guard fails, with the OTHER arm's target", () => {
    const v = previewEvent(laneDesc, review(3, 3), "FAIL", {
      parts: laneParts,
      samples: laneSamples,
    });
    expect(v.guard).toMatchObject({ branch: "else", target: "frozen" });
    expect(v.resolved).toBe("frozen");
  });

  it("the branch flips with the SAMPLE, not only with the state", () => {
    // `retriesRemaining` reads `m.reason !== "fatal"` — so varying the sample
    // is what makes the payload editor in a UI worth having.
    const fatal: Samples<typeof lane> = {
      ...laneSamples,
      FAIL: { at: 5, reason: "fatal" },
    };
    expect(
      previewEvent(laneDesc, review(0, 3), "FAIL", {
        parts: laneParts,
        samples: fatal,
      }).guard,
    ).toMatchObject({ branch: "else", target: "frozen" });
  });

  it("AGREES WITH THE MACHINE — the previewed branch is where replay lands", () => {
    const machine = defineMachine<
      LaneState,
      LaneMsg,
      LaneCmd,
      Sub<never>,
      Record<never, never>
    >({
      init: initFrom<typeof lane, LaneState, LaneCmd>(lane, () => ({
        retries: 0,
        maxRetries: 3,
      })),
      update: compile(lane, { assign: laneAssign, guards: laneGuards }),
    });
    for (const [retries, reason] of [
      [0, "flaky"],
      [3, "flaky"],
      [0, "fatal"],
    ] as const) {
      const from = review(retries, 3);
      const samples: Samples<typeof lane> = {
        ...laneSamples,
        FAIL: { at: 5, reason },
      };
      const predicted = previewEvent(laneDesc, from, "FAIL", {
        parts: laneParts,
        samples,
      });
      const actual = replay(machine, {
        msgs: [{ type: "FAIL", at: 5, reason }],
        ctx: {},
        loaded: from,
      });
      expect(predicted.resolved).toBe(actual.state.type);
    }
  });

  it("degrades to `unknown` with WHY when there is no guards bag", () => {
    const v = previewEvent(laneDesc, review(0, 3), "FAIL", {
      samples: laneSamples,
    });
    expect(v.guard).toEqual({
      guard: "retriesRemaining",
      branch: "unknown",
      why: "no-guard-bag",
    });
    // still legal, still shows both declared targets — only the branch is open
    expect(v.status).toBe("legal");
    expect(v.targets).toEqual(["build", "frozen"]);
    expect(v.resolved).toBeUndefined();
  });

  it("degrades to `unknown` when the named guard has no implementation", () => {
    const v = previewEvent(laneDesc, review(0, 3), "FAIL", {
      parts: { guards: {} },
      samples: laneSamples,
    });
    expect(v.guard).toMatchObject({
      branch: "unknown",
      why: "no-implementation",
    });
  });

  it("degrades to `unknown` when the event's payload has no sample", () => {
    const v = previewEvent(laneDesc, review(0, 3), "FAIL", {
      parts: laneParts,
    });
    expect(v.guard).toMatchObject({ branch: "unknown", why: "no-sample" });
    expect(v.msg).toBeUndefined();
  });

  it("degrades to `unknown` — carrying the message — when the guard throws", () => {
    const v = previewEvent(laneDesc, review(0, 3), "FAIL", {
      parts: {
        guards: {
          retriesRemaining: () => {
            throw new Error("needs a db handle");
          },
        },
      },
      samples: laneSamples,
    });
    expect(v.guard).toEqual({
      guard: "retriesRemaining",
      branch: "unknown",
      why: "threw",
      error: "needs a db handle",
    });
  });

  it("passes the site tag `at`, so a multi-site guard can discriminate", () => {
    const seen: string[] = [];
    previewEvent(laneDesc, review(0, 3), "FAIL", {
      parts: {
        guards: {
          retriesRemaining: (_s, _m, at) => {
            seen.push(at);
            return true;
          },
        },
      },
      samples: laneSamples,
    });
    expect(seen).toEqual(["review.FAIL"]);
  });
});

describe("cell edges — the declared fan-out, and the resolved one", () => {
  const pollDesc = describeChart(pollerChart);
  const polling = (phase: "polling" | "done" | "gave_up"): PollState =>
    ({
      type: phase,
      jobId: "j",
      poll: {
        phase,
        attempts: 0,
        lastResult: null,
        lastError: null,
        nextAtMs: null,
      },
    }) as unknown as PollState;

  it("shows the whole declared `to` when the cell cannot be run", () => {
    const v = previewEvent(pollDesc, polling("polling"), "poll_result");
    expect(v.status).toBe("legal");
    expect(v.targets).toEqual(["polling", "done"]);
    expect(v.resolved).toBeUndefined();
  });

  it("runs the cell purely, with samples, to resolve the ACTUAL target", () => {
    const ready = previewEvent(pollDesc, polling("polling"), "poll_result", {
      parts: { cells: pollCells as never },
      samples: {
        start_polling: { at: 0 },
        deadline_exceeded: { id: "d" as never, atMs: 0 },
        poll_result: { result: { status: "ready", progress: 100 }, at: 1 },
        poll_failed: { error: "e", at: 1 },
      },
    });
    expect(ready.resolved).toBe("done");
    expect(ready.resolvedBy).toBe("cell");
  });

  it("a different sample drives the cell to a different declared target", () => {
    const pending = previewEvent(pollDesc, polling("polling"), "poll_result", {
      parts: { cells: pollCells as never },
      samples: {
        start_polling: { at: 0 },
        deadline_exceeded: { id: "d" as never, atMs: 0 },
        poll_result: { result: { status: "pending", progress: 10 }, at: 1 },
        poll_failed: { error: "e", at: 1 },
      },
    });
    expect(pending.resolved).toBe("polling");
  });

  it("a throwing cell resolves to nothing rather than crashing the preview", () => {
    const v = previewEvent(pollDesc, polling("polling"), "poll_result", {
      parts: {
        cells: {
          onResult: () => {
            throw new Error("battery exploded");
          },
        },
      },
      samples: {
        start_polling: { at: 0 },
        deadline_exceeded: { id: "d" as never, atMs: 0 },
        poll_result: { result: { status: "ready", progress: 1 }, at: 1 },
        poll_failed: { error: "e", at: 1 },
      },
    });
    expect(v.status).toBe("legal");
    expect(v.resolved).toBeUndefined();
    expect(v.targets).toEqual(["polling", "done"]);
  });

  it("refuses to draw a target outside the edge's declared `to`", () => {
    // The runtime throws `CellTargetError` here; a preview must not draw the
    // out-of-range target as if it were reachable.
    const v = previewEvent(pollDesc, polling("polling"), "poll_result", {
      parts: {
        cells: { onResult: () => [{ type: "gave_up" }, []] as never },
      },
      samples: {
        start_polling: { at: 0 },
        deadline_exceeded: { id: "d" as never, atMs: 0 },
        poll_result: { result: { status: "ready", progress: 1 }, at: 1 },
        poll_failed: { error: "e", at: 1 },
      },
    });
    expect(v.resolved).toBeUndefined();
  });

  it("resolves the per-site cell form by its `at` key", () => {
    const v = previewEvent(pollDesc, polling("done"), "poll_result", {
      parts: {
        cells: {
          onResult: {
            "done.poll_result": () => [{ type: "polling" }, []],
          } as never,
        },
      },
      samples: {
        start_polling: { at: 0 },
        deadline_exceeded: { id: "d" as never, atMs: 0 },
        poll_result: { result: { status: "ready", progress: 1 }, at: 1 },
        poll_failed: { error: "e", at: 1 },
      },
    });
    expect(v.resolved).toBe("polling");
    // …and a site the per-site bag has no entry for stays unresolved.
    const other = previewEvent(pollDesc, polling("polling"), "poll_result", {
      parts: {
        cells: {
          onResult: {
            "done.poll_result": () => [{ type: "polling" }, []],
          } as never,
        },
      },
      samples: {
        start_polling: { at: 0 },
        deadline_exceeded: { id: "d" as never, atMs: 0 },
        poll_result: { result: { status: "ready", progress: 1 }, at: 1 },
        poll_failed: { error: "e", at: 1 },
      },
    });
    expect(other.resolved).toBeUndefined();
  });
});

describe("samples — the msg the preview actually used", () => {
  it("stamps the chart's `type` onto the author's payload", () => {
    const v = previewEvent(laneDesc, review(0, 3), "FAIL", {
      samples: laneSamples,
    });
    expect(v.msg).toEqual({ type: "FAIL", at: 5, reason: "flaky" });
  });

  it("needs no sample for an event that declares no payload", () => {
    const uDesc = describeChart(upload);
    const checking = { type: "checking", key: "k", etag: "e", tries: 0 };
    const v = previewEvent(uDesc, checking, "ok");
    expect(v.msg).toEqual({ type: "ok" });
    expect(v.resolved).toBe("idle");
  });
});

describe("from — who would send this, carried to the button row", () => {
  it("stamps the declared origin on a legal event", () => {
    expect(previewEvent(laneDesc, review(0, 3), "PASS").from).toBe("cmd");
    expect(previewEvent(laneDesc, review(0, 3), "BLOCKED").from).toEqual({
      world: "the operator",
    });
  });

  it("stamps it on a REFUSED one too — a refusal has a sender", () => {
    // `UNBLOCKED` is scoped to `parked`, so it is refused at `review`. A UI
    // grouping its controls by sender still has to file this one.
    const v = previewEvent(laneDesc, review(0, 3), "UNBLOCKED");
    expect(v.status).toBe("refused");
    expect(v.from).toEqual({ world: "a human" });
  });

  it("leaves it absent on a chart that declares no provenance", () => {
    const uDesc = describeChart(upload);
    const checking = { type: "checking", key: "k", etag: "e", tries: 0 };
    expect(previewEvent(uDesc, checking, "ok").from).toBeUndefined();
  });
});
