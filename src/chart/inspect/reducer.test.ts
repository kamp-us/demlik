// ═══════════════════════════════════════════════════════════════════════════
// THE REDUCER FORM'S DESCRIPTION — asserted for what it says AND for what it
// refuses to say.
//
// `fetchReducerChart` is the real port of `examples/resilient-fetch.ts`: four
// events, three cells, one declarative edge, one foreign event. `gate` below is
// a small chart written for the two things it does not have — a guarded edge
// and a declared cmd.
//
// The refusal half matters as much as the description half: an empty
// `refusals: []` would read as "nothing is refused", which is a lie about a
// form that has no state dimension to refuse from.
// ═══════════════════════════════════════════════════════════════════════════
import { describe, expect, it } from "vitest";
import {
  cells,
  fetchReducerChart,
  fetchReducerInit,
} from "../__fixtures__/resilient-fetch-reducer";
import {
  defineReducerChart,
  type MsgOf,
  type RGuards,
  type RStateOf,
  ty,
} from "../graph";
import {
  describeReducerChart,
  inspectReducerState,
  previewReducerEvent,
  reducerEdgeAt,
} from "./reducer";

const desc = describeReducerChart(fetchReducerChart);

// ── a second chart, for the parts the port does not use ───────────────────
const gate = defineReducerChart({
  ctx: ty<{ readonly tries: number }>(),
  states: ["open", "closed", "dead"],
  initial: "open",
  cmds: { log: ty<{ readonly line: string }>() },
  events: {
    trip: {
      data: ty<{ readonly reason: string }>(),
      from: { world: "human" },
    },
    reset: {},
  },
  on: {
    trip: {
      target: "closed",
      when: "hasBudget",
      otherwise: "dead",
      cmd: "log",
      otherwiseCmd: "log",
    },
    reset: "open",
  },
});
type GG = typeof gate;
type GState = RStateOf<GG>;
type GMsg = MsgOf<GG>;
const gDesc = describeReducerChart(gate);
const gGuards: RGuards<GG, GState, GMsg> = {
  hasBudget: (s) => s.tries < 3,
};
describe("describeReducerChart — what this form can truthfully say", () => {
  it("reads the flat state list and the entry state off the chart", () => {
    expect(desc.states).toEqual([
      "idle",
      "succeeded",
      "circuit_open",
      "failed",
      "waiting_retry",
      "fetching",
    ]);
    // `initial` is a field here, not a marked node — one word, still never
    // repeated by the author.
    expect(desc.initial).toBe("idle");
  });

  it("reads the event alphabet, with `foreign`, `from` and payload-ness", () => {
    expect(desc.events.map((e) => e.name)).toEqual([
      "fetch",
      "fetch_ok",
      "fetch_err",
      "deadline_exceeded",
    ]);
    expect(desc.events.every((e) => e.hasPayload)).toBe(true);
    // the library-minted event whose name was never ours to namespace.
    expect(
      desc.events.find((e) => e.name === "deadline_exceeded")?.foreign,
    ).toBe(true);
    expect(desc.events.find((e) => e.name === "fetch")?.foreign).toBe(false);
    // `from` survives the loss of the phase dimension — "who sent this" has
    // exactly as much content here as in the grid form.
    expect(gDesc.events.find((e) => e.name === "trip")?.from).toEqual({
      world: "human",
    });
    expect(gDesc.events.find((e) => e.name === "reset")?.from).toBeUndefined();
  });

  it("reads a cell edge as its whole declared `to` fan-out", () => {
    expect(reducerEdgeAt(desc, "fetch_err")).toEqual({
      event: "fetch_err",
      // the site key IS the event — one dimension, so no `state.event` pair.
      at: "fetch_err",
      kind: "cell",
      targets: ["failed", "waiting_retry"],
      cell: "onErr",
      cmds: [],
      otherwiseCmds: [],
    });
  });

  it("reads the one declarative edge, and a guarded edge's two arms", () => {
    expect(reducerEdgeAt(desc, "fetch_ok")).toEqual({
      event: "fetch_ok",
      at: "fetch_ok",
      kind: "plain",
      targets: ["succeeded"],
      cmds: [],
      otherwiseCmds: [],
    });
    expect(reducerEdgeAt(gDesc, "trip")).toEqual({
      event: "trip",
      at: "trip",
      kind: "guarded",
      targets: ["closed", "dead"],
      guard: "hasBudget",
      // biome-ignore lint/suspicious/noThenProperty: `then` is a guarded edge's HOLDS arm, mirroring the chart's `{ then, else }` assign shape — never a thenable
      then: "closed",
      otherwise: "dead",
      cmds: ["log"],
      otherwiseCmds: ["log"],
    });
  });

  it("collects the cmd, guard and cell alphabets", () => {
    expect(desc.cmds).toEqual(["do_fetch"]);
    expect(desc.cells).toEqual(["attempt", "onErr", "retryNow"]);
    expect(desc.guards).toEqual([]);
    expect(gDesc.guards).toEqual(["hasBudget"]);
    expect(gDesc.cells).toEqual([]);
  });

  // TOTALITY, one quantifier smaller — and stricter than the grid form's,
  // because `on` is a REQUIRED mapped type rather than a `scope` convention.
  it("reports totality over the event alphabet", () => {
    expect(desc.total).toBe(true);
    expect(desc.missing).toEqual([]);
    expect(desc.events.every((e) => e.routed)).toBe(true);
  });

  it("reports a routed-nowhere event when the types were bypassed", () => {
    const cast = describeReducerChart({
      states: ["a"],
      initial: "a",
      events: { X: {}, Y: {} },
      on: { X: "a" },
    } as unknown as typeof gate);
    expect(cast.total).toBe(false);
    expect(cast.missing).toEqual(["Y"]);
    expect(cast.events.find((e) => e.name === "Y")?.routed).toBe(false);
  });
});

describe("describeReducerChart — what it refuses to answer", () => {
  it("does not fake per-state refusals — it says there is no state dimension", () => {
    expect(desc.refusals.answerable).toBe(false);
    expect(desc.refusals.question).toBe("refusals");
    expect(desc.refusals.why).toContain("no state dimension");
  });

  it("does not fake phases or scope either", () => {
    expect(desc.phases.answerable).toBe(false);
    expect(desc.phases.why).toContain("no phase dimension");
    expect(desc.scope.answerable).toBe(false);
    expect(desc.scope.why).toContain("no phase dimension");
  });
});

describe("inspectReducerState — the live button row", () => {
  // a REAL state — the cells read the circuit/retry/cache ctx, and a preview
  // that hands them a stub is testing the degradation path, not the cell.
  const s = {
    ...fetchReducerInit(null)[0],
    type: "waiting_retry",
    url: "u://x",
  };

  it("previews every event, and none of them can be refused", () => {
    const row = inspectReducerState(desc, s);
    expect(row.map((v) => v.event)).toEqual(desc.events.map((e) => e.name));
    // There is no `status` to be "legal": this form has nothing with which to
    // refuse an event, so a legality tag would be a distinction with one case.
    expect(row.every((v) => v.edge !== undefined)).toBe(true);
  });

  it("runs a cell purely to report the target it actually picks", () => {
    const v = previewReducerEvent(desc, s, "fetch_err", {
      parts: { cells: cells as never },
      samples: { fetch_err: { url: "u://x", error: "boom", at: 10 } },
    });
    expect(v.targets).toEqual(["failed", "waiting_retry"]);
    expect(v.resolved).toBe("waiting_retry");
    expect(v.resolvedBy).toBe("cell");
    // the declared cmds are empty BY DECLARATION — the cell builds its own.
    expect(v.cmds).toEqual([]);
  });

  it("runs a guard and reports the branch, with that arm's cmds", () => {
    const open = { type: "open", tries: 0 };
    const spent = { type: "open", tries: 9 };
    const at = (st: object) =>
      previewReducerEvent(gDesc, st as { readonly type: string }, "trip", {
        parts: { guards: gGuards as never },
        samples: { trip: { reason: "flaky" } },
      });
    expect(at(open).guard?.branch).toBe("then");
    expect(at(open).resolved).toBe("closed");
    expect(at(spent).guard?.branch).toBe("else");
    expect(at(spent).resolved).toBe("dead");
  });

  it("degrades honestly where a part or a sample is missing", () => {
    const v = previewReducerEvent(gDesc, { type: "open" }, "trip");
    expect(v.guard).toEqual({
      guard: "hasBudget",
      branch: "unknown",
      why: "no-guard-bag",
    });
    // the `then` arm's declared cmds — the happy path, with `unknown` saying so.
    expect(v.cmds).toEqual(["log"]);
    expect(v.resolved).toBeUndefined();
  });

  it("builds the msg from the sample plus the chart's own `type`", () => {
    const v = previewReducerEvent(gDesc, { type: "open" }, "trip", {
      samples: { trip: { reason: "flaky" } },
    });
    expect(v.msg).toEqual({ type: "trip", reason: "flaky" });
    // no payload declared → nothing to supply, and the msg is still buildable.
    expect(previewReducerEvent(gDesc, { type: "open" }, "reset").msg).toEqual({
      type: "reset",
    });
    // a payload declared and no sample → the honest `undefined`.
    expect(
      previewReducerEvent(gDesc, { type: "open" }, "trip").msg,
    ).toBeUndefined();
  });
});
