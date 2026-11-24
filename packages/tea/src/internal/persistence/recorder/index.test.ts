import { describe, expect, it } from "vitest";
import { Cmd, defineMachine, replay } from "../../../index";
import { run } from "../../../promise";
import { replayTrace } from "../trace-replay";
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
type State = { _tag: "counting"; count: number; log: readonly string[] };
type Msg =
  | { _tag: "inc"; by: number }
  | { _tag: "dec"; by: number }
  | { _tag: "note"; text: string };

function counter() {
  return defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      ctx: {} as Record<string, never>,
    },
    init: (loaded) => [
      loaded ?? { _tag: "counting", count: 0, log: [] },
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

    await runtime.dispatch({ _tag: "inc", by: 5 });
    await runtime.dispatch({ _tag: "dec", by: 2 });
    await runtime.dispatch({ _tag: "note", text: "hi" });

    const trace = rec.dump();

    // loaded = the post-init initial state captured at the boot observe.
    expect(trace.loaded).toEqual({ _tag: "counting", count: 0, log: [] });
    // msgs = the ordered, non-null msgs.
    expect(trace.msgs).toEqual([
      { _tag: "inc", by: 5 },
      { _tag: "dec", by: 2 },
      { _tag: "note", text: "hi" },
    ]);
    // finalState = the last observed state.
    expect(trace.finalState).toEqual({
      _tag: "counting",
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

    await runtime.dispatch({ _tag: "inc", by: 1 });
    await runtime.dispatch({ _tag: "inc", by: 1 });

    const trace = rec.dump();
    expect(trace.steps).toEqual([
      {
        msg: { _tag: "inc", by: 1 },
        state: { _tag: "counting", count: 1, log: [] },
        cmds: [],
      },
      {
        msg: { _tag: "inc", by: 1 },
        state: { _tag: "counting", count: 2, log: [] },
        cmds: [],
      },
    ]);

    await runtime.stop();
  });

  it("round-trips through toJSONL / parseJSONL to an equal Trace", async () => {
    const runtime = run(counter(), { ctx: {} });
    const rec = recorder(runtime, { captureSteps: true });
    await runtime.ready;

    await runtime.dispatch({ _tag: "inc", by: 10 });
    await runtime.dispatch({ _tag: "note", text: "checkpoint" });
    await runtime.dispatch({ _tag: "dec", by: 3 });

    const dumped = rec.dump();
    const jsonl = rec.toJSONL();

    // JSONL is one JSON object per line: a boot header then one step per msg.
    const lines = jsonl.split("\n");
    expect(lines).toHaveLength(1 + dumped.msgs.length);
    expect(JSON.parse(lines[0])).toEqual({
      kind: "boot",
      state: { _tag: "counting", count: 0, log: [] },
    });

    const rehydrated = parseJSONL<State, Msg>(jsonl);
    expect(rehydrated).toEqual(dumped);

    await runtime.stop();
  });

  it("stop() halts capture; dump() still works on the frozen buffer", async () => {
    const runtime = run(counter(), { ctx: {} });
    const rec = recorder(runtime);
    await runtime.ready;

    await runtime.dispatch({ _tag: "inc", by: 1 });
    rec.stop();
    // Dispatched AFTER stop — must NOT be recorded.
    await runtime.dispatch({ _tag: "inc", by: 100 });

    const trace = rec.dump();
    expect(trace.msgs).toEqual([{ _tag: "inc", by: 1 }]);
    // finalState froze at the last observed (pre-stop) transition.
    expect(trace.finalState).toEqual({ _tag: "counting", count: 1, log: [] });

    // stop() is idempotent.
    expect(() => rec.stop()).not.toThrow();

    await runtime.stop();
  });

  it("parseJSONL of a boot-only trace yields an empty-msgs Trace", () => {
    const jsonl = JSON.stringify({
      kind: "boot",
      state: { _tag: "counting", count: 0, log: [] },
    });
    const trace = parseJSONL<State, Msg>(jsonl);
    expect(trace.loaded).toEqual({ _tag: "counting", count: 0, log: [] });
    expect(trace.msgs).toEqual([]);
    expect(trace.finalState).toEqual({ _tag: "counting", count: 0, log: [] });
  });

  it("parseJSONL throws on a missing boot header", () => {
    const jsonl = JSON.stringify({
      kind: "step",
      msg: { _tag: "inc", by: 1 },
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

    await runtime.dispatch({ _tag: "inc", by: 5 });
    await runtime.dispatch({ _tag: "note", text: "a" });
    await runtime.dispatch({ _tag: "dec", by: 2 });
    await runtime.dispatch({ _tag: "inc", by: 10 });

    const dumped = rec.dump();

    // One step per msg, each with the POST-transition state, in order.
    expect(dumped.steps).toEqual([
      {
        msg: { _tag: "inc", by: 5 },
        state: { _tag: "counting", count: 5, log: [] },
        cmds: [],
      },
      {
        msg: { _tag: "note", text: "a" },
        state: { _tag: "counting", count: 5, log: ["a"] },
        cmds: [],
      },
      {
        msg: { _tag: "dec", by: 2 },
        state: { _tag: "counting", count: 3, log: ["a"] },
        cmds: [],
      },
      {
        msg: { _tag: "inc", by: 10 },
        state: { _tag: "counting", count: 13, log: ["a"] },
        cmds: [],
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

    await runtime.dispatch({ _tag: "inc", by: 7 });
    await runtime.dispatch({ _tag: "note", text: "x" });
    await runtime.dispatch({ _tag: "dec", by: 3 });

    const dumped = rec.dump();
    // No per-step retention in the default mode.
    expect(dumped.steps).toBeUndefined();
    // But loaded + msgs + finalState are intact — the minimal replay-faithful
    // trace.
    expect(dumped.loaded).toEqual({ _tag: "counting", count: 0, log: [] });
    expect(dumped.finalState).toEqual({
      _tag: "counting",
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
      { _tag: "inc", by: 1 },
      { _tag: "note", text: "boom" },
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
      { _tag: "inc", by: 1 },
      { _tag: "dec", by: 2 },
      { _tag: "note", text: "boom" },
    ]);
    const crumbs = breadcrumbsFromTrace(trace);

    expect(crumbs).toHaveLength(3);
    // Default message is msg._tag; order is dispatch order (newest last).
    expect(crumbs.map((c) => c.message)).toEqual(["inc", "dec", "note"]);
    // Every crumb carries the canonical Sentry-shaped fields.
    expect(crumbs[0]).toEqual({
      category: "tea",
      type: "default",
      level: "info",
      message: "inc",
      data: { msg: { _tag: "inc", by: 1 } },
    });
    // The full msg survives verbatim under data.msg.
    expect(crumbs.at(-1)?.data?.msg).toEqual({ _tag: "note", text: "boom" });
  });

  it("breadcrumbsFromTrace honors the limit (keeps the newest `limit` msgs)", async () => {
    const trace = await recordedTrace([
      { _tag: "inc", by: 1 },
      { _tag: "inc", by: 2 },
      { _tag: "inc", by: 3 },
      { _tag: "inc", by: 4 },
      { _tag: "inc", by: 5 },
    ]);
    const crumbs = breadcrumbsFromTrace(trace, { limit: 2 });

    // The two NEWEST msgs, in order.
    expect(crumbs).toHaveLength(2);
    expect(crumbs.map((c) => c.data?.msg)).toEqual([
      { _tag: "inc", by: 4 },
      { _tag: "inc", by: 5 },
    ]);
  });

  it("breadcrumbsFromTrace honors a custom serialize while keeping the full msg in data", async () => {
    const trace = await recordedTrace([
      { _tag: "inc", by: 9 },
      { _tag: "note", text: "tag" },
    ]);
    const crumbs = breadcrumbsFromTrace(trace, {
      serialize: (m) =>
        m._tag === "note"
          ? `note(${m.text})`
          : `${m._tag}(${"by" in m ? m.by : ""})`,
    });

    expect(crumbs.map((c) => c.message)).toEqual(["inc(9)", "note(tag)"]);
    // serialize affects `message` only — data.msg stays the structured msg.
    expect(crumbs[0].data?.msg).toEqual({ _tag: "inc", by: 9 });
  });

  it("breadcrumbsFromTrace with limit 0 yields no breadcrumbs", async () => {
    const trace = await recordedTrace([{ _tag: "inc", by: 1 }]);
    expect(breadcrumbsFromTrace(trace, { limit: 0 })).toEqual([]);
  });
});

describe("recorder window", () => {
  async function recordRun(
    count: number,
    opts?: Parameters<typeof recorder>[1],
  ) {
    const runtime = run(counter(), { ctx: {} });
    const rec = recorder(runtime, opts);
    await runtime.ready;
    for (let i = 0; i < count; i++) {
      await runtime.dispatch(
        i % 3 === 2
          ? { _tag: "note", text: `n${i}` }
          : { _tag: i % 3 === 0 ? "inc" : "dec", by: i },
      );
    }
    await runtime.stop();
    return rec;
  }

  it("a 1000-transition run with window 10 dumps 10 msgs, skipped 990, and replays to finalState", async () => {
    const full = (await recordRun(1000)).dump();
    const rec = await recordRun(1000, { window: 10 });
    const trace = rec.dump();

    expect(trace.msgs).toHaveLength(10);
    expect(trace.skipped).toBe(990);
    expect(trace.msgs).toEqual(full.msgs.slice(990));
    expect(trace.finalState).toEqual(full.finalState);
    expect(trace.loaded).not.toEqual(full.loaded);

    const result = replayTrace(counter(), trace);
    expect(result.matches).toBe(true);
    expect(result.actual).toEqual(trace.finalState);
  });

  it("the windowed trace round-trips through toJSONL and parseJSONL and still replays", async () => {
    const rec = await recordRun(1000, { window: 10 });
    const jsonl = rec.toJSONL();
    expect(JSON.parse(jsonl.split("\n")[0] as string).skipped).toBe(990);

    const rehydrated = parseJSONL<State, Msg>(jsonl);
    expect(rehydrated.skipped).toBe(990);
    expect(rehydrated.msgs).toEqual(rec.dump().msgs);
    expect(rehydrated.loaded).toEqual(rec.dump().loaded);

    const result = replayTrace(counter(), rehydrated);
    expect(result.matches).toBe(true);
    expect(result.actual).toEqual(rec.dump().finalState);
  });

  it("a run shorter than the window equals the unbounded trace with skipped 0", async () => {
    const unbounded = await recordRun(7);
    const windowed = await recordRun(7, { window: 10 });
    expect(windowed.dump()).toEqual(unbounded.dump());
    expect(windowed.dump().skipped ?? 0).toBe(0);
    expect(windowed.toJSONL()).toBe(unbounded.toJSONL());

    const exact = await recordRun(10, { window: 10 });
    expect(exact.dump().skipped ?? 0).toBe(0);
    expect(exact.dump()).toEqual((await recordRun(10)).dump());
  });

  it("captureSteps with a window keeps exactly the window's steps", async () => {
    const full = (await recordRun(50, { captureSteps: true })).dump();
    const rec = await recordRun(50, { window: 5, captureSteps: true });
    const trace = rec.dump();

    expect(trace.steps).toHaveLength(5);
    expect(trace.steps).toEqual(full.steps?.slice(45));
    expect(trace.steps?.map((s) => s.msg)).toEqual(trace.msgs);
    expect(trace.steps?.at(-1)?.state).toEqual(trace.finalState);
    expect(trace.loaded).toEqual(full.steps?.[44]?.state);

    const rehydrated = parseJSONL<State, Msg>(rec.toJSONL());
    expect(rehydrated).toEqual(trace);
    expect(replayTrace(counter(), rehydrated).matches).toBe(true);
  });

  it("numbers the first kept step as the live run's step skipped + 1", async () => {
    const full = (await recordRun(25, { captureSteps: true })).dump();
    const trace = (
      await recordRun(25, { window: 4, captureSteps: true })
    ).dump();
    const skipped = trace.skipped ?? 0;
    for (const [i, step] of (trace.steps ?? []).entries()) {
      expect(step).toEqual(full.steps?.[skipped + i]);
    }
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("window %s throws a RangeError", (window) => {
    const runtime = run(counter(), { ctx: {} });
    expect(() => recorder(runtime, { window })).toThrow(RangeError);
  });

  it("window with a sampleRate below 1 throws a RangeError", () => {
    const runtime = run(counter(), { ctx: {} });
    expect(() => recorder(runtime, { window: 10, sampleRate: 0.5 })).toThrow(
      RangeError,
    );
    expect(() =>
      recorder(runtime, { window: 10, sampleRate: 1 }),
    ).not.toThrow();
  });

  it("without options the JSONL is unchanged: the boot line carries no skipped", async () => {
    const rec = await recordRun(4);
    const lines = rec.toJSONL().split("\n");
    expect(lines[0]).toBe(
      JSON.stringify({
        kind: "boot",
        state: { _tag: "counting", count: 0, log: [] },
      }),
    );
    expect(lines).toHaveLength(5);
    expect(rec.dump()).not.toHaveProperty("skipped");
    expect(parseJSONL<State, Msg>(rec.toJSONL())).not.toHaveProperty("skipped");
  });

  it("parseJSONL rejects a boot line with an invalid skipped count", () => {
    const boot = (skipped: unknown) =>
      JSON.stringify({
        kind: "boot",
        state: { _tag: "counting", count: 0, log: [] },
        skipped,
      });
    expect(() => parseJSONL(boot(-1))).toThrow(/skipped/);
    expect(() => parseJSONL(boot(1.5))).toThrow(/skipped/);
    expect(() => parseJSONL(boot("3"))).toThrow(/skipped/);
    expect(parseJSONL(boot(0))).not.toHaveProperty("skipped");
  });
});
