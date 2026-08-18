// ═══════════════════════════════════════════════════════════════════════════
// THE CAPTURED CMDS, ASSERTED AGAINST REAL MACHINES.
//
// The claim under test is the one the declarative preview cannot make: what
// ACTUALLY fired. Two charts carry it — `upload`, whose edges declare cmds per
// guard arm (so "only the arm that ran" is checkable against a chart that
// declares both), and the resilient-fetch REDUCER, whose cells build their cmds
// inside their bodies (so the chart declares none and the capture finds them).
// ═══════════════════════════════════════════════════════════════════════════
import { describe, expect, it } from "vitest";
import type { Cmd, Machine, Sub } from "../../index";
import { defineMachine } from "../../runtime-types";
import {
  fetchReducerChart,
  fetchReducerInit,
  fetchReducerUpdate,
  type RFDoFetch,
  type RFMsg,
  type RFState,
} from "../__fixtures__/resilient-fetch-reducer";
import {
  type UCmd,
  type UMsgIn,
  type UState,
  upload as uploadChart,
  uploadMachine,
} from "../__fixtures__/upload";
import { captureCmds, firedAt, firedCounts } from "./captured";
import { describeChart, edgeAt } from "./describe";
import { describeReducerChart, reducerEdgeAt } from "./reducer";

const NO_CTX = {} as Record<never, never>;

const uploader = uploadMachine as unknown as Machine<
  UState,
  UMsgIn,
  UCmd,
  Sub<never>,
  Record<never, never>
>;

const captureUpload = (msgs: readonly UMsgIn[]) =>
  captureCmds(uploader, { msgs, ctx: NO_CTX });

describe("captureCmds — one row per step, in fire order", () => {
  it("starts at step 0, whose cause is `init` and not the first msg", () => {
    const cap = captureUpload([]);
    expect(cap.steps).toEqual([{ step: 0, by: null, cmds: [] }]);
    expect(cap.cmds).toEqual([]);
  });

  it("tags every cmd with the msg that caused it", () => {
    const cap = captureUpload([
      { type: "up.pick", key: "k1" },
      { type: "up.done", etag: "e1" },
    ]);
    expect(cap.steps.map((s) => [s.step, s.by?.type ?? null])).toEqual([
      [0, null],
      [1, "up.pick"],
      [2, "up.done"],
    ]);
    expect(firedAt(cap, 1)?.cmds).toEqual([{ type: "put_object", key: "k1" }]);
    // an ORDERED list off one edge — the order is the firing order.
    expect(firedAt(cap, 2)?.cmds.map((c) => c.type)).toEqual([
      "verify_object",
      "log",
    ]);
    expect(cap.cmds.map((c) => c.type)).toEqual([
      "put_object",
      "verify_object",
      "log",
    ]);
  });

  it("captures the arm that RAN, where the chart declares both", () => {
    // `sending.fail` declares `cmd: log` and `otherwiseCmd: [log, alert_human]`
    // — the before question cannot say which. `tries` starts at 0, so the guard
    // holds and only the `then` arm's cmd is emitted.
    const declared = edgeAt(describeChart(uploadChart), "sending", "fail");
    expect(declared?.cmds).toEqual(["log"]);
    expect(declared?.otherwiseCmds).toEqual(["log", "alert_human"]);

    const cap = captureUpload([
      { type: "up.pick", key: "k1" },
      { type: "up.fail", error: "boom" },
    ]);
    expect(firedAt(cap, 2)?.cmds).toEqual([
      { type: "log", line: "failed k1: boom" },
    ]);
  });

  it("rolls the whole run up by cmd name", () => {
    const cap = captureUpload([
      { type: "up.pick", key: "k1" },
      { type: "up.fail", error: "boom" },
      { type: "up.pick", key: "k2" },
    ]);
    expect(firedCounts(cap)).toEqual([
      { type: "put_object", count: 2 },
      { type: "log", count: 1 },
    ]);
  });
});

// The gap this module exists to close: the chart declares NO cmds for a cell
// edge, because the cell builds them in its body — so the declarative preview
// is empty for exactly the edges that do the most interesting work, and the
// capture is where those effects become visible.
describe("captureCmds — the cmds a CELL built, which no chart declares", () => {
  const rDesc = describeReducerChart(fetchReducerChart);
  const machine = defineMachine<
    RFState,
    RFMsg,
    RFDoFetch,
    Sub<never>,
    Record<never, never>
  >({
    init: fetchReducerInit,
    update: fetchReducerUpdate,
    interpret: { do_fetch: async () => undefined },
  });

  it("the chart declares none — that is the whole problem", () => {
    const edge = reducerEdgeAt(rDesc, "fetch");
    expect(edge?.kind).toBe("cell");
    expect(edge?.cmds).toEqual([]);
  });

  it("…and the capture reports the one the cell actually emitted", () => {
    const cap = captureCmds(machine, {
      msgs: [{ type: "fetch", url: "u://x", at: 1_000 }] as readonly RFMsg[],
      ctx: NO_CTX,
    });
    expect(firedAt(cap, 1)?.cmds).toEqual([{ type: "do_fetch", url: "u://x" }]);
    expect(firedAt(cap, 1)?.by?.type).toBe("fetch");
  });

  it("…and reports nothing for the step whose cell chose not to emit", () => {
    const cap = captureCmds(machine, {
      msgs: [
        { type: "fetch", url: "u://x", at: 1_000 },
        { type: "fetch_ok", url: "u://x", body: "hi", at: 1_010 },
        // served from cache: same cell, same edge, no effect.
        { type: "fetch", url: "u://x", at: 1_020 },
      ] as readonly RFMsg[],
      ctx: NO_CTX,
    });
    expect(cap.steps.map((s) => s.cmds.length)).toEqual([0, 1, 0, 0]);
  });
});

describe("captureCmds — honest degradation", () => {
  it("truncates at the step that threw and says so", () => {
    type S = { readonly type: "a"; readonly n: number };
    type M = { readonly type: "ok" } | { readonly type: "boom" };
    const machine = defineMachine<
      S,
      M,
      Cmd<"e">,
      Sub<never>,
      Record<never, never>
    >({
      init: () => [{ type: "a", n: 0 }, []],
      update: {
        ok: (s) => [{ ...s, n: s.n + 1 }, [{ type: "e" } as Cmd<"e">]],
        boom: () => {
          throw new Error("the cell blew up");
        },
      },
      interpret: { e: async () => undefined },
    });

    const cap = captureCmds(machine, {
      msgs: [{ type: "ok" }, { type: "boom" }, { type: "ok" }] as readonly M[],
      ctx: NO_CTX,
    });
    // steps 0 and 1 are known; the fold could not get past step 2.
    expect(cap.steps.map((s) => s.step)).toEqual([0, 1]);
    expect(cap.stoppedAt?.step).toBe(2);
    expect(cap.stoppedAt?.error).toContain("the cell blew up");
    expect(firedAt(cap, 2)).toBeUndefined();
  });
});
