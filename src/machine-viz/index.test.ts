import { describe, expect, it } from "vitest";
import { Cmd, defineMachine } from "../index";
import { toMermaid } from "./index";

// ---------------------------------------------------------------------------
// Transitions-form fixture: a traffic light. State is a discriminated union
// over the active phase; one cell per (state.type × msg.type).
// ---------------------------------------------------------------------------
type LightState = { type: "red" } | { type: "green" } | { type: "yellow" };
type LightMsg = { type: "go" } | { type: "caution" } | { type: "stop" };
type LightCmd = Cmd<never>;
type LightCtx = Record<string, never>;

const trafficLight = defineMachine<
  LightState,
  LightMsg,
  LightCmd,
  never,
  LightCtx
>({
  init: (loaded) => [loaded ?? { type: "red" }, Cmd.none],
  update: {
    red: {
      go: () => [{ type: "green" }, Cmd.none],
      caution: (s) => [s, Cmd.none],
      stop: (s) => [s, Cmd.none],
    },
    green: {
      go: (s) => [s, Cmd.none],
      caution: () => [{ type: "yellow" }, Cmd.none],
      stop: () => [{ type: "red" }, Cmd.none],
    },
    yellow: {
      go: (s) => [s, Cmd.none],
      caution: (s) => [s, Cmd.none],
      stop: () => [{ type: "red" }, Cmd.none],
    },
  },
});

// ---------------------------------------------------------------------------
// Reducer-form fixture: a counter. State is a plain record (no phase union);
// update is a flat dispatch table keyed by msg.type.
// ---------------------------------------------------------------------------
type CounterState = { count: number };
type CounterMsg =
  | { type: "increment" }
  | { type: "decrement" }
  | { type: "reset" };

const counter = defineMachine<
  CounterState,
  CounterMsg,
  Cmd<never>,
  never,
  Record<string, never>
>({
  init: (loaded) => [loaded ?? { count: 0 }, Cmd.none],
  update: {
    increment: (s) => [{ count: s.count + 1 }, Cmd.none],
    decrement: (s) => [{ count: s.count - 1 }, Cmd.none],
    reset: () => [{ count: 0 }, Cmd.none],
  },
});

describe("toMermaid — Transitions form", () => {
  it("emits stateDiagram-v2 with every state.type as a node", () => {
    const out = toMermaid(trafficLight);
    expect(out).toContain("stateDiagram-v2");
    expect(out).toContain("  red");
    expect(out).toContain("  green");
    expect(out).toContain("  yellow");
  });

  it("draws RESOLVED edges by executing cells with samples", () => {
    const out = toMermaid(trafficLight, {
      samples: {
        states: {
          red: { type: "red" },
          green: { type: "green" },
          yellow: { type: "yellow" },
        },
        msgs: {
          go: { type: "go" },
          caution: { type: "caution" },
          stop: { type: "stop" },
        },
      },
    });
    // The load-bearing assertion: real target states, derived by execution.
    expect(out).toContain("red --> green : go");
    expect(out).toContain("green --> yellow : caution");
    expect(out).toContain("green --> red : stop");
    expect(out).toContain("yellow --> red : stop");
    // A self-transition (cell returns its own state) resolves to a self-edge,
    // NOT a structural `?` edge — it was executed.
    expect(out).toContain("red --> red : caution");
    expect(out).not.toContain("caution?");
  });

  it("draws STRUCTURAL self-loops with a ? suffix when samples are absent", () => {
    const out = toMermaid(trafficLight); // no samples
    expect(out).toContain("red --> red : go?");
    expect(out).toContain("green --> green : caution?");
    // Structural edges never resolve to a different target.
    expect(out).not.toContain("red --> green");
    // Legend documents the structural marker.
    expect(out).toContain("STRUCTURAL");
  });

  it("draws the [*] init edge only when samples.ctx is provided", () => {
    const withCtx = toMermaid(trafficLight, { samples: { ctx: {} } });
    expect(withCtx).toContain("[*] --> red");

    const withoutCtx = toMermaid(trafficLight);
    expect(withoutCtx).not.toContain("[*] -->");
    expect(withoutCtx).toContain("init edge omitted");
  });
});

describe("toMermaid — Reducer form", () => {
  it("lists the handled msg types with an honest no-phase-graph note", () => {
    const out = toMermaid(counter);
    expect(out).toContain("stateDiagram-v2");
    expect(out).toContain("Reducer-form machine");
    expect(out).toContain("No phase graph");
    expect(out).toContain("increment");
    expect(out).toContain("decrement");
    expect(out).toContain("reset");
    // No invented phase edges.
    expect(out).not.toContain(" --> ");
  });
});

describe("toMermaid — subscriptions annotation", () => {
  type SubState = { type: "idle" } | { type: "running" };
  const withSubs = defineMachine<
    SubState,
    { type: "start" } | { type: "stop" },
    Cmd<never>,
    { type: "tick"; id: import("../index").SubId },
    Record<string, never>
  >({
    init: (loaded) => [loaded ?? { type: "idle" }, Cmd.none],
    update: {
      idle: {
        start: () => [{ type: "running" }, Cmd.none],
        stop: (s) => [s, Cmd.none],
      },
      running: {
        start: (s) => [s, Cmd.none],
        stop: () => [{ type: "idle" }, Cmd.none],
      },
    },
    subscriptions: (state) =>
      state.type === "running"
        ? [{ type: "tick", id: "tick" as import("../index").SubId }]
        : [],
    subscribe: {
      tick: (_sub, _ctx, _dispatch) => () => {},
    },
  });

  it("annotates active subs per sampled state, calling subscriptions (not subscribe)", () => {
    const out = toMermaid(withSubs, {
      samples: {
        states: { idle: { type: "idle" }, running: { type: "running" } },
      },
    });
    expect(out).toContain("subs: tick");
    expect(out).toContain("(no active subs)");
  });

  it("skips sub annotation entirely when no state samples are provided", () => {
    const out = toMermaid(withSubs);
    expect(out).not.toContain("subs:");
    expect(out).not.toContain("no active subs");
  });
});

describe("toMermaid — options", () => {
  it("honors the direction option", () => {
    expect(toMermaid(counter, { direction: "LR" })).toContain("direction LR");
    expect(toMermaid(counter)).toContain("direction TB");
  });

  it("emits a title front-matter block when title is provided", () => {
    const out = toMermaid(trafficLight, { title: "Traffic Light" });
    expect(out.startsWith("---\ntitle: Traffic Light\n---")).toBe(true);
  });

  it("is deterministic for the same input", () => {
    const a = toMermaid(trafficLight, { title: "x", direction: "LR" });
    const b = toMermaid(trafficLight, { title: "x", direction: "LR" });
    expect(a).toBe(b);
  });
});
