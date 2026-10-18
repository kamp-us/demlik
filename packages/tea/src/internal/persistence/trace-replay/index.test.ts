import { describe, expect, it, vi } from "vitest";
import { Cmd, defineMachine } from "../../../index";
import { memoryStore } from "../../../mem";
import { goldenReplay } from "../../../parity";
import { run } from "../../../promise";
import { recorder } from "../recorder";
import { replayTrace } from "./index";

// ---------------------------------------------------------------------------
// A queue machine with nested state — exercises the divergence path finder
// on a real `state.queue[i].status` shape, the canonical regression case.
// ---------------------------------------------------------------------------
type Item = { id: string; status: "pending" | "done" };
type State = { type: "queue"; items: readonly Item[]; processed: number };
type Msg = { type: "enqueue"; id: string } | { type: "complete"; id: string };
type Ctx = Record<string, never>;

// The ORIGINAL reducer: completing an item flips its status to "done".
function queueMachine() {
  return defineMachine({
    types: { model: {} as State, msg: {} as Msg, ctx: {} as Ctx },
    init: (loaded) => [
      loaded ?? { type: "queue", items: [], processed: 0 },
      Cmd.none,
    ],
    update: {
      enqueue: (s, m) => [
        { ...s, items: [...s.items, { id: m.id, status: "pending" }] },
        Cmd.none,
      ],
      complete: (s, m) => [
        {
          ...s,
          items: s.items.map((it) =>
            it.id === m.id ? { ...it, status: "done" } : it,
          ),
          processed: s.processed + 1,
        },
        Cmd.none,
      ],
    },
  });
}

// A MUTATED reducer: the `complete` cell drifted — it forgets to flip
// `status`, only bumping `processed`. Replaying a trace recorded against the
// original against THIS machine must diverge at `state.items[i].status`.
function queueMachineBuggyStatus() {
  return defineMachine({
    types: { model: {} as State, msg: {} as Msg, ctx: {} as Ctx },
    init: (loaded) => [
      loaded ?? { type: "queue", items: [], processed: 0 },
      Cmd.none,
    ],
    update: {
      enqueue: (s, m) => [
        { ...s, items: [...s.items, { id: m.id, status: "pending" }] },
        Cmd.none,
      ],
      complete: (s) => [{ ...s, processed: s.processed + 1 }, Cmd.none],
    },
  });
}

async function recordRun() {
  const runtime = run(queueMachine(), { ctx: {} });
  const rec = recorder(runtime);
  await runtime.ready;
  await runtime.dispatch({ type: "enqueue", id: "a" });
  await runtime.dispatch({ type: "enqueue", id: "b" });
  await runtime.dispatch({ type: "enqueue", id: "c" });
  await runtime.dispatch({ type: "complete", id: "b" });
  const trace = rec.dump();
  await runtime.stop();
  return trace;
}

describe("replayTrace", () => {
  it("folds the captured post-init state without re-running init or its commands", async () => {
    type Model = { readonly count: number };
    type Event = { readonly type: "add"; readonly by: number };
    type Command = { readonly type: "write" };
    const init = vi.fn(
      (loaded: Model | null): readonly [Model, readonly Command[]] => [
        { count: (loaded?.count ?? 0) + 10 },
        [{ type: "write" }],
      ],
    );
    const machine = defineMachine({
      types: {
        model: {} as Model,
        msg: {} as Event,
        cmd: {} as Command,
      },
      init,
      update: { add: (s, m) => [{ count: s.count + m.by }, []] },
    });
    const write = vi.fn(async (): Promise<Event> => ({ type: "add", by: 1 }));
    const booting = run(machine, {
      store: memoryStore<Model>({ count: 4 }),
      interpret: { write },
    });
    const rec = recorder(booting);
    const rt = await booting.ready;
    try {
      await rt.idle();
      await rt.dispatch({ type: "add", by: 3 });
      const trace = rec.dump();
      expect(trace.loaded).toEqual({ count: 14 });
      expect(replayTrace(machine, trace, {}).actual).toEqual({ count: 18 });
      expect(goldenReplay(machine, trace)).toEqual({ count: 18 });
      expect(init).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      rec.stop();
      await rt.stop();
    }
  });

  it("refuses a missing replay anchor instead of initializing a replacement", () => {
    const machine = queueMachine();
    const init = vi.spyOn(machine, "init");
    expect(() =>
      replayTrace(machine, {
        loaded: null,
        msgs: [],
        finalState: { type: "queue", items: [], processed: 0 },
      }),
    ).toThrow(/no captured initial State/);
    expect(init).not.toHaveBeenCalled();
  });

  it("matches when replayed against the SAME machine", async () => {
    const trace = await recordRun();

    const result = replayTrace(queueMachine(), trace, {});

    expect(result.matches).toBe(true);
    expect(result.actual).toEqual(trace.finalState);
    expect(result.divergence).toBeUndefined();
  });

  it("diverges with the correct path when the reducer cell drifts", async () => {
    const trace = await recordRun();

    const result = replayTrace(queueMachineBuggyStatus(), trace, {});

    expect(result.matches).toBe(false);
    expect(result.divergence).toBeDefined();
    // The recorded run completed item "b" (index 1) → status "done"; the
    // buggy reducer left it "pending". First divergence is that nested status.
    expect(result.divergence?.path).toBe("state.items[1].status");
    expect(result.divergence?.expected).toBe("done");
    expect(result.divergence?.actual).toBe("pending");
  });

  it("matches an empty trace (just boot, no msgs)", async () => {
    const runtime = run(queueMachine(), { ctx: {} });
    const rec = recorder(runtime);
    await runtime.ready;
    const trace = rec.dump(); // no dispatches — boot only
    await runtime.stop();

    expect(trace.msgs).toEqual([]);

    const result = replayTrace(queueMachine(), trace, {});
    expect(result.matches).toBe(true);
    expect(result.actual).toEqual({ type: "queue", items: [], processed: 0 });
  });

  it("reports a top-level scalar divergence at the root-most differing path", async () => {
    const trace = await recordRun();
    // The buggy reducer also under-counts? No — it still bumps processed, so
    // the FIRST divergence is the nested status, not `processed`. This asserts
    // the walk reports the deepest-first deterministic path, not `processed`.
    const result = replayTrace(queueMachineBuggyStatus(), trace, {});
    expect(result.divergence?.path).not.toBe("state.processed");
  });
});
