import { describe, expect, it } from "vitest";
import { Cmd, defineMachine, replay, run } from "../index";
import {
  breadcrumbsFromTrace,
  parseJSONL,
  recorder,
  traceAttachment,
} from "./index";

// ---------------------------------------------------------------------------
// A small, store-less counter machine. No store ⇒ synchronous init, so boot
// observe fires on the first microtask via `stepBootEffects`; `await
// runtime.ready` guarantees it has fired before we read.
// ---------------------------------------------------------------------------
type State = { type: "counting"; count: number; log: readonly string[] };
type Msg =
  | { type: "inc"; by: number }
  | { type: "dec"; by: number }
  | { type: "note"; text: string };

function counter() {
  return defineMachine<State, Msg, Cmd<never>, never, Record<string, never>>({
    init: (loaded) => [
      loaded ?? { type: "counting", count: 0, log: [] },
      Cmd.none,
    ],
    update: {
      inc: (s, m) => [{ ...s, count: s.count + m.by }, Cmd.none],
      dec: (s, m) => [{ ...s, count: s.count - m.by }, Cmd.none],
      note: (s, m) => [{ ...s, log: [...s.log, m.text] }, Cmd.none],
    },
  });
}

describe("recorder", () => {
  it("captures loaded (initial), the ordered msg sequence, and finalState", async () => {
    const runtime = run(counter(), { ctx: {} });
    const rec = recorder(runtime);
    await runtime.ready; // boot observe fires here

    await runtime.dispatch({ type: "inc", by: 5 });
    await runtime.dispatch({ type: "dec", by: 2 });
    await runtime.dispatch({ type: "note", text: "hi" });

    const trace = rec.dump();

    // loaded = the post-init initial state captured at the boot observe.
    expect(trace.loaded).toEqual({ type: "counting", count: 0, log: [] });
    // msgs = the ordered, non-null msgs.
    expect(trace.msgs).toEqual([
      { type: "inc", by: 5 },
      { type: "dec", by: 2 },
      { type: "note", text: "hi" },
    ]);
    // finalState = the last observed state.
    expect(trace.finalState).toEqual({
      type: "counting",
      count: 3,
      log: ["hi"],
    });
    // steps omitted by default (captureSteps not set).
    expect(trace.steps).toBeUndefined();

    await runtime.stop();
  });

  it("retains per-transition steps when captureSteps is true", async () => {
    const runtime = run(counter(), { ctx: {} });
    const rec = recorder(runtime, { captureSteps: true });
    await runtime.ready;

    await runtime.dispatch({ type: "inc", by: 1 });
    await runtime.dispatch({ type: "inc", by: 1 });

    const trace = rec.dump();
    expect(trace.steps).toEqual([
      {
        msg: { type: "inc", by: 1 },
        state: { type: "counting", count: 1, log: [] },
      },
      {
        msg: { type: "inc", by: 1 },
        state: { type: "counting", count: 2, log: [] },
      },
    ]);

    await runtime.stop();
  });

  it("round-trips through toJSONL / parseJSONL to an equal Trace", async () => {
    const runtime = run(counter(), { ctx: {} });
    const rec = recorder(runtime, { captureSteps: true });
    await runtime.ready;

    await runtime.dispatch({ type: "inc", by: 10 });
    await runtime.dispatch({ type: "note", text: "checkpoint" });
    await runtime.dispatch({ type: "dec", by: 3 });

    const dumped = rec.dump();
    const jsonl = rec.toJSONL();

    // JSONL is one JSON object per line: a boot header then one step per msg.
    const lines = jsonl.split("\n");
    expect(lines).toHaveLength(1 + dumped.msgs.length);
    expect(JSON.parse(lines[0])).toEqual({
      kind: "boot",
      state: { type: "counting", count: 0, log: [] },
    });

    const rehydrated = parseJSONL<State, Msg>(jsonl);
    expect(rehydrated).toEqual(dumped);

    await runtime.stop();
  });

  it("stop() halts capture; dump() still works on the frozen buffer", async () => {
    const runtime = run(counter(), { ctx: {} });
    const rec = recorder(runtime);
    await runtime.ready;

    await runtime.dispatch({ type: "inc", by: 1 });
    rec.stop();
    // Dispatched AFTER stop — must NOT be recorded.
    await runtime.dispatch({ type: "inc", by: 100 });

    const trace = rec.dump();
    expect(trace.msgs).toEqual([{ type: "inc", by: 1 }]);
    // finalState froze at the last observed (pre-stop) transition.
    expect(trace.finalState).toEqual({ type: "counting", count: 1, log: [] });

    // stop() is idempotent.
    expect(() => rec.stop()).not.toThrow();

    await runtime.stop();
  });

  it("parseJSONL of a boot-only trace yields an empty-msgs Trace", () => {
    const jsonl = JSON.stringify({
      kind: "boot",
      state: { type: "counting", count: 0, log: [] },
    });
    const trace = parseJSONL<State, Msg>(jsonl);
    expect(trace.loaded).toEqual({ type: "counting", count: 0, log: [] });
    expect(trace.msgs).toEqual([]);
    expect(trace.finalState).toEqual({ type: "counting", count: 0, log: [] });
  });

  it("parseJSONL throws on a missing boot header", () => {
    const jsonl = JSON.stringify({
      kind: "step",
      msg: { type: "inc", by: 1 },
      state: null,
    });
    expect(() => parseJSONL<State, Msg>(jsonl)).toThrow(
      /before the boot header|no boot header/,
    );
  });

  // -------------------------------------------------------------------------
  // Goal A — captureSteps is first-class: EVERY transition's post-state is
  // captured and survives the JSONL round-trip; the default (no captureSteps)
  // trace drops per-step states but STILL replays faithfully.
  // -------------------------------------------------------------------------
  it("captureSteps records every transition's post-state and round-trips it through JSONL", async () => {
    const runtime = run(counter(), { ctx: {} });
    const rec = recorder(runtime, { captureSteps: true });
    await runtime.ready;

    await runtime.dispatch({ type: "inc", by: 5 });
    await runtime.dispatch({ type: "note", text: "a" });
    await runtime.dispatch({ type: "dec", by: 2 });
    await runtime.dispatch({ type: "inc", by: 10 });

    const dumped = rec.dump();

    // One step per msg, each with the POST-transition state, in order.
    expect(dumped.steps).toEqual([
      {
        msg: { type: "inc", by: 5 },
        state: { type: "counting", count: 5, log: [] },
      },
      {
        msg: { type: "note", text: "a" },
        state: { type: "counting", count: 5, log: ["a"] },
      },
      {
        msg: { type: "dec", by: 2 },
        state: { type: "counting", count: 3, log: ["a"] },
      },
      {
        msg: { type: "inc", by: 10 },
        state: { type: "counting", count: 13, log: ["a"] },
      },
    ]);
    // The last step's state IS the finalState (the step invariant).
    expect(dumped.steps?.at(-1)?.state).toEqual(dumped.finalState);

    // Every step line in JSONL carries a NON-NULL state when captureSteps is on.
    const jsonl = rec.toJSONL();
    const stepLines = jsonl
      .split("\n")
      .slice(1) // drop boot header
      .map((l) => JSON.parse(l) as { kind: string; state: unknown });
    expect(stepLines).toHaveLength(dumped.msgs.length);
    for (const line of stepLines) {
      expect(line.state).not.toBeNull();
    }

    // The round-trip reconstructs `steps` EXACTLY, so the re-hydrated Trace
    // deep-equals the dump.
    const rehydrated = parseJSONL<State, Msg>(jsonl);
    expect(rehydrated).toEqual(dumped);
    expect(rehydrated.steps).toEqual(dumped.steps);

    await runtime.stop();
  });

  it("default trace (no captureSteps) omits steps but still replays correctly", async () => {
    const runtime = run(counter(), { ctx: {} });
    const rec = recorder(runtime); // default: captureSteps false
    await runtime.ready;

    await runtime.dispatch({ type: "inc", by: 7 });
    await runtime.dispatch({ type: "note", text: "x" });
    await runtime.dispatch({ type: "dec", by: 3 });

    const dumped = rec.dump();
    // No per-step retention in the default mode.
    expect(dumped.steps).toBeUndefined();
    // But loaded + msgs + finalState are intact — the minimal replay-faithful
    // trace.
    expect(dumped.loaded).toEqual({ type: "counting", count: 0, log: [] });
    expect(dumped.finalState).toEqual({
      type: "counting",
      count: 4,
      log: ["x"],
    });

    // Replaying the trace's input against the SAME machine recomputes the
    // recorded finalState — proves the default trace is replay-faithful.
    const replayed = replay(counter(), {
      msgs: dumped.msgs,
      ctx: {},
      loaded: dumped.loaded,
    });
    expect(replayed.state).toEqual(dumped.finalState);

    // The default JSONL leaves interior step states null (only the last carries
    // finalState) — still replay-faithful after a round-trip.
    const rehydrated = parseJSONL<State, Msg>(rec.toJSONL());
    const replayedFromJsonl = replay(counter(), {
      msgs: rehydrated.msgs,
      ctx: {},
      loaded: rehydrated.loaded,
    });
    expect(replayedFromJsonl.state).toEqual(dumped.finalState);
    expect(rehydrated.finalState).toEqual(dumped.finalState);

    await runtime.stop();
  });
});

// ---------------------------------------------------------------------------
// Goal B — Sentry crash→trace adapters. Pure functions over a Trace; the
// returned objects match Sentry's Attachment / Breadcrumb shapes exactly.
// ---------------------------------------------------------------------------
describe("Sentry adapters", () => {
  async function recordedTrace(steps: Msg[]) {
    const runtime = run(counter(), { ctx: {} });
    const rec = recorder(runtime, { captureSteps: true });
    await runtime.ready;
    for (const m of steps) await runtime.dispatch(m);
    const trace = rec.dump();
    await runtime.stop();
    return trace;
  }

  it("traceAttachment emits the exact Sentry Attachment shape with JSONL data", async () => {
    const trace = await recordedTrace([
      { type: "inc", by: 1 },
      { type: "note", text: "boom" },
    ]);
    const att = traceAttachment(trace);

    expect(att.filename).toBe("tea-trace.jsonl");
    expect(att.contentType).toBe("application/x-ndjson");
    // `data` is the JSONL wire format — parseJSONL re-hydrates an equal Trace.
    const rehydrated = parseJSONL<State, Msg>(att.data);
    expect(rehydrated).toEqual(trace);
  });

  it("breadcrumbsFromTrace emits one Sentry Breadcrumb per msg, newest-last", async () => {
    const trace = await recordedTrace([
      { type: "inc", by: 1 },
      { type: "dec", by: 2 },
      { type: "note", text: "boom" },
    ]);
    const crumbs = breadcrumbsFromTrace(trace);

    expect(crumbs).toHaveLength(3);
    // Default message is msg.type; order is dispatch order (newest last).
    expect(crumbs.map((c) => c.message)).toEqual(["inc", "dec", "note"]);
    // Every crumb carries the canonical Sentry-shaped fields.
    expect(crumbs[0]).toEqual({
      category: "tea",
      type: "default",
      level: "info",
      message: "inc",
      data: { msg: { type: "inc", by: 1 } },
    });
    // The full msg survives verbatim under data.msg.
    expect(crumbs.at(-1)?.data?.msg).toEqual({ type: "note", text: "boom" });
  });

  it("breadcrumbsFromTrace honors the limit (keeps the newest `limit` msgs)", async () => {
    const trace = await recordedTrace([
      { type: "inc", by: 1 },
      { type: "inc", by: 2 },
      { type: "inc", by: 3 },
      { type: "inc", by: 4 },
      { type: "inc", by: 5 },
    ]);
    const crumbs = breadcrumbsFromTrace(trace, { limit: 2 });

    // The two NEWEST msgs, in order.
    expect(crumbs).toHaveLength(2);
    expect(crumbs.map((c) => c.data?.msg)).toEqual([
      { type: "inc", by: 4 },
      { type: "inc", by: 5 },
    ]);
  });

  it("breadcrumbsFromTrace honors a custom serialize while keeping the full msg in data", async () => {
    const trace = await recordedTrace([
      { type: "inc", by: 9 },
      { type: "note", text: "tag" },
    ]);
    const crumbs = breadcrumbsFromTrace(trace, {
      serialize: (m) =>
        m.type === "note"
          ? `note(${m.text})`
          : `${m.type}(${"by" in m ? m.by : ""})`,
    });

    expect(crumbs.map((c) => c.message)).toEqual(["inc(9)", "note(tag)"]);
    // serialize affects `message` only — data.msg stays the structured msg.
    expect(crumbs[0].data?.msg).toEqual({ type: "inc", by: 9 });
  });

  it("breadcrumbsFromTrace with limit 0 yields no breadcrumbs", async () => {
    const trace = await recordedTrace([{ type: "inc", by: 1 }]);
    expect(breadcrumbsFromTrace(trace, { limit: 0 })).toEqual([]);
  });
});
