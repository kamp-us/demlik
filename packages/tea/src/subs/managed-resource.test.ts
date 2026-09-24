import { describe, expect, it } from "vitest";
import {
  DisposeTimeoutNotice,
  defineMachine,
  type NoCtx,
  type OnError,
  type Reducer,
  subIdOf,
} from "../index";
import { run } from "../promise";
import {
  defineManagedResource,
  type ManagedResourceSub,
} from "./managed-resource";

// The claim under test is the acquire-as-success-value discipline (see the
// module header): `release` receives ONLY what `acquire` returned, `release` is
// mandatory, and both ride the substrate's reconcile pass — so a phase exit or
// a key change can never leak the resource, and a throwing `acquire` can never
// hand `release` a half-built one.

type Handle = { readonly key: string; released: boolean };

function tracker() {
  const acquired: string[] = [];
  const released: Handle[] = [];
  return {
    acquired,
    released,
    acquire(key: string): Handle {
      acquired.push(key);
      return { key, released: false };
    },
    release(handle: Handle): void {
      handle.released = true;
      released.push(handle);
    },
  };
}

type State = { readonly runId: string | null };
type Msg =
  | { readonly type: "switch"; readonly runId: string }
  | { readonly type: "finish" };

const update: Reducer<State, Msg, never> = {
  switch: (_s, m) => [{ runId: m.runId }, []],
  finish: () => [{ runId: null }, []],
};

type Battery = ReturnType<
  typeof defineManagedResource<"checkpoint", string, Handle, NoCtx>
>;

function machineFor(battery: Battery) {
  return defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      sub: {} as ManagedResourceSub<"checkpoint", string>,
      ctx: {} as NoCtx,
    },
    init: (_loaded) => [{ runId: "run-1" }, []],
    update,
    subs: [battery.depKeyed((s: State) => s.runId)],
  });
}

function runFor(
  battery: Battery,
  opts: { readonly onError?: OnError; readonly disposeTimeoutMs?: number } = {},
) {
  return run(machineFor(battery), {
    ...opts,
    subscribe: { checkpoint: battery.subscribe },
  });
}

describe("defineManagedResource — acquire on appear, release on exit", () => {
  it("acquires when the key turns non-null", async () => {
    const t = tracker();
    const battery = defineManagedResource<"checkpoint", string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => t.acquire(key),
      release: (h) => t.release(h),
    });
    const rt = await runFor(battery).ready;

    expect(t.acquired).toEqual(["run-1"]);
    expect(t.released).toEqual([]);

    await rt.stop();
  });

  it("releases when the phase is left — the leak this battery kills", async () => {
    const t = tracker();
    const battery = defineManagedResource<"checkpoint", string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => t.acquire(key),
      release: (h) => t.release(h),
    });
    const rt = await runFor(battery).ready;

    await rt.dispatch({ type: "finish" });
    expect(t.released).toHaveLength(1);
    expect(t.released[0]?.key).toBe("run-1");
    expect(t.released[0]?.released).toBe(true);

    await rt.stop();
  });

  it("a key change retires the old resource and acquires a fresh one", async () => {
    const t = tracker();
    const battery = defineManagedResource<"checkpoint", string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => t.acquire(key),
      release: (h) => t.release(h),
    });
    const rt = await runFor(battery).ready;

    await rt.dispatch({ type: "switch", runId: "run-2" });
    expect(t.acquired).toEqual(["run-1", "run-2"]);
    expect(t.released.map((h) => h.key)).toEqual(["run-1"]);

    await rt.stop();
  });

  it("release receives the EXACT handle acquire returned", async () => {
    const handles: Handle[] = [];
    let releasedWith: Handle | null = null;
    const battery = defineManagedResource<"checkpoint", string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => {
        const h = { key, released: false };
        handles.push(h);
        return h;
      },
      release: (h) => {
        releasedWith = h;
      },
    });
    const rt = await runFor(battery).ready;

    await rt.dispatch({ type: "finish" });
    expect(releasedWith).toBe(handles[0]);

    await rt.stop();
  });

  it("get() reads the live handle while held, undefined once torn down", async () => {
    const t = tracker();
    const battery = defineManagedResource<"checkpoint", string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => t.acquire(key),
      release: (h) => t.release(h),
    });
    const rt = await runFor(battery).ready;

    expect(battery.get("run-1")?.key).toBe("run-1");
    expect(battery.get("never-acquired")).toBeUndefined();

    await rt.dispatch({ type: "finish" });
    expect(battery.get("run-1")).toBeUndefined();

    await rt.stop();
  });

  it("get() returns the SAME owner the reconciler holds, not a rebuild", async () => {
    const built: Handle[] = [];
    const battery = defineManagedResource<"checkpoint", string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => {
        const h = { key, released: false };
        built.push(h);
        return h;
      },
      release: () => {},
    });
    const rt = await runFor(battery).ready;

    expect(battery.get("run-1")).toBe(built[0]);
    expect(built).toHaveLength(1);

    await rt.stop();
  });

  it("an acquire that throws never produces a handle, so release never runs", async () => {
    const released: Handle[] = [];
    const battery = defineManagedResource<"checkpoint", string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: () => {
        throw new Error("half-built");
      },
      release: (h) => {
        released.push(h);
      },
    });

    // The throw surfaces out of the reconcile pass; what matters for the
    // discipline is that no dangling half-built resource exists afterwards.
    await runFor(battery).ready.catch(() => undefined);

    expect(released).toEqual([]);
    expect(battery.get("run-1")).toBeUndefined();
  });

  // A failing teardown is not a Msg and never rejects the transition — but it
  // is not a `console.warn` at the battery either. The release rides the
  // substrate's cleanup path, so its failure reaches the runtime's ONE sink
  // under `phase: "sub-cleanup"`, the same place a Sub cleanup throw lands.
  it("a release that throws is routed to the sink, not surfaced as a Msg", async () => {
    const reports: Array<{ error: unknown; phase: string }> = [];
    const battery = defineManagedResource<"checkpoint", string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => ({ key, released: false }),
      release: () => {
        throw new Error("teardown failed");
      },
    });
    const rt = await runFor(battery, {
      onError: (error, context) =>
        reports.push({ error, phase: context.phase }),
    }).ready;

    await expect(rt.dispatch({ type: "finish" })).resolves.toBeUndefined();
    expect(reports).toEqual([
      { error: expect.any(Error), phase: "sub-cleanup" },
    ]);
    // Forgotten regardless: the handle table is cleaned before release runs.
    expect(battery.get("run-1")).toBeUndefined();

    await rt.stop();
  });

  it("a rejected async release is routed to the sink, not surfaced as a Msg", async () => {
    const reports: Array<{ error: unknown; phase: string }> = [];
    const battery = defineManagedResource<"checkpoint", string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => ({ key, released: false }),
      release: () => Promise.reject(new Error("async teardown failed")),
    });
    const rt = await runFor(battery, {
      onError: (error, context) =>
        reports.push({ error, phase: context.phase }),
    }).ready;

    await expect(rt.dispatch({ type: "finish" })).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports).toEqual([
      { error: expect.any(Error), phase: "sub-cleanup" },
    ]);

    await rt.stop();
  });

  it("stop() releases a still-held resource", async () => {
    const t = tracker();
    const battery = defineManagedResource<"checkpoint", string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => t.acquire(key),
      release: (h) => t.release(h),
    });
    const rt = await runFor(battery).ready;

    await rt.stop();
    expect(t.released.map((h) => h.key)).toEqual(["run-1"]);
  });

  it("the battery's name is its Sub type", () => {
    const battery = defineManagedResource<"checkpoint", string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => ({ key, released: false }),
      release: () => {},
    });
    expect(battery.type).toBe("checkpoint");
    expect(battery.depKeyed((s: State) => s.runId).type).toBe("checkpoint");
  });

  it("keeps a string key and a numeric key distinct in the handle table", () => {
    const battery = defineManagedResource<
      "checkpoint",
      string | number,
      Handle,
      NoCtx
    >({
      name: "checkpoint",
      acquire: (key) => ({ key: String(key), released: false }),
      release: () => {},
    });
    const dispose = battery.subscribe(
      { id: subIdOf("checkpoint", "1"), type: "checkpoint", deps: "1" },
      {},
      () => {},
    );
    expect(battery.get("1")?.key).toBe("1");
    expect(battery.get(1)).toBeUndefined();
    void dispose();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Two managed resources in one machine: each battery's name is its own Sub
// type with its own runner, and each gate travels with its resource — no
// router, no combinator, and a phase one gate does not cover simply leaves
// that resource off.
// ───────────────────────────────────────────────────────────────────────────

type MultiState = { readonly phase: "idle" | "running" | "reporting" };
type MultiMsg = { readonly type: "goto"; readonly phase: MultiState["phase"] };

const multiUpdate: Reducer<MultiState, MultiMsg, never> = {
  goto: (_s, m) => [{ phase: m.phase }, []],
};

describe("defineManagedResource — two resources, two Sub types", () => {
  function twoResources() {
    const t = tracker();
    const checkpoint = defineManagedResource<
      "checkpoint",
      string,
      Handle,
      NoCtx
    >({
      name: "checkpoint",
      acquire: (key) => t.acquire(`checkpoint:${key}`),
      release: (h) => t.release(h),
    });
    const bridge = defineManagedResource<"bridge", string, Handle, NoCtx>({
      name: "bridge",
      acquire: (key) => t.acquire(`bridge:${key}`),
      release: (h) => t.release(h),
    });
    const machine = defineMachine({
      types: {
        model: {} as MultiState,
        msg: {} as MultiMsg,
        sub: {} as
          | ManagedResourceSub<"checkpoint", string>
          | ManagedResourceSub<"bridge", string>,
        ctx: {} as NoCtx,
      },
      init: (_loaded) => [{ phase: "idle" }, []],
      update: multiUpdate,
      // Same key on both: the Sub type is part of the id, so the two run
      // side by side instead of deduping onto one.
      subs: [
        checkpoint.depKeyed((s: MultiState) =>
          s.phase === "running" ? "run-1" : null,
        ),
        bridge.depKeyed((s: MultiState) =>
          s.phase === "running" || s.phase === "reporting" ? "run-1" : null,
        ),
      ],
    });
    const start = () =>
      run(machine, {
        subscribe: {
          checkpoint: checkpoint.subscribe,
          bridge: bridge.subscribe,
        },
      }).ready;
    return { t, checkpoint, bridge, start };
  }

  it("runs each resource through its own runner, gated by its own `deps`", async () => {
    const { t, start } = twoResources();
    const rt = await start();

    await rt.dispatch({ type: "goto", phase: "running" });
    expect(t.acquired.sort()).toEqual(["bridge:run-1", "checkpoint:run-1"]);

    // Leaving `running` drops only the checkpoint; the bridge's own gate keeps
    // it alive in `reporting`.
    await rt.dispatch({ type: "goto", phase: "reporting" });
    expect(t.released.map((h) => h.key)).toEqual(["checkpoint:run-1"]);

    await rt.dispatch({ type: "goto", phase: "idle" });
    expect(t.released.map((h) => h.key).sort()).toEqual([
      "bridge:run-1",
      "checkpoint:run-1",
    ]);

    await rt.stop();
  });

  it("keeps each battery's handle table to itself", async () => {
    const { checkpoint, bridge, start } = twoResources();
    const rt = await start();

    await rt.dispatch({ type: "goto", phase: "running" });
    expect(checkpoint.get("run-1")?.key).toBe("checkpoint:run-1");
    expect(bridge.get("run-1")?.key).toBe("bridge:run-1");

    await rt.stop();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F1c: the handle table is keyed on `structuralHash(key)`. A non-plain key
// (a `Date`, a branded class, a `RunId` value object — the shapes a run
// identity actually takes) rendered as `"{}"`, so EVERY key was one key: no
// release on re-key, no re-acquire, and `.get(newKey)` handing back the
// previous run's handle. The key is refused instead.
// ───────────────────────────────────────────────────────────────────────────
describe("defineManagedResource — a non-plain key is refused, never collapsed", () => {
  class RunKey {
    constructor(readonly value: string) {}
  }

  function keyedBattery() {
    return defineManagedResource<"checkpoint", RunKey, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => ({ key: key.value, released: false }),
      release: (h) => {
        h.released = true;
      },
    });
  }

  it("throws when the engine derives the id, rather than one id for every key", () => {
    expect(() => subIdOf("checkpoint", new RunKey("A"))).toThrow(
      /non-plain object/,
    );
  });

  it("throws on `get` rather than returning the previous key's handle", () => {
    const battery = keyedBattery();
    expect(() => battery.get(new RunKey("B"))).toThrow(/non-plain object/);
  });

  it("still keys happily on the plain projection of that identity", () => {
    const battery = defineManagedResource<
      "checkpoint",
      { readonly runId: string },
      Handle,
      NoCtx
    >({
      name: "checkpoint",
      acquire: (key) => ({ key: key.runId, released: false }),
      release: (h) => {
        h.released = true;
      },
    });
    const sub = (runId: string) => ({
      id: subIdOf("checkpoint", { runId }),
      type: "checkpoint" as const,
      deps: { runId },
    });
    const disposeA = battery.subscribe(sub("A"), {}, () => {});
    const disposeB = battery.subscribe(sub("B"), {}, () => {});
    expect(battery.get({ runId: "A" })?.key).toBe("A");
    expect(battery.get({ runId: "B" })?.key).toBe("B");
    void disposeA();
    void disposeB();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F5: `release` may be async, and the whole reason this battery exists is that
// teardown is GUARANTEED. `stop()` used to fire the release and return, so a
// host doing `await runtime.stop(); env.evict()` dropped the isolate mid-flush
// — the leak the battery prevents, relocated to shutdown. `stop()` now awaits
// the disposals it started, bounded so a release that never settles cannot
// hang the host.
// ───────────────────────────────────────────────────────────────────────────
describe("defineManagedResource — `stop()` awaits an async release", () => {
  it("does not resolve `stop()` before an async release has settled", async () => {
    let released = false;
    const battery = defineManagedResource<"checkpoint", string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => ({ key, released: false }),
      release: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        released = true;
      },
    });
    const rt = await runFor(battery).ready;

    await rt.stop();
    expect(released).toBe(true);
  });

  it("awaits the release a re-key started, not only the one `stop()` starts", async () => {
    const settled: string[] = [];
    const battery = defineManagedResource<"checkpoint", string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => ({ key, released: false }),
      release: async (h) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        settled.push(h.key);
      },
    });
    const rt = await runFor(battery).ready;

    // Re-key: the old handle's release starts mid-run, outside `stop()`.
    await rt.dispatch({ type: "switch", runId: "run-2" });
    await rt.stop();
    expect(settled.sort()).toEqual(["run-1", "run-2"]);
  });

  it("reports a rejected release to the sink instead of the console", async () => {
    const reports: Array<{ error: unknown; phase: string }> = [];
    const battery = defineManagedResource<"checkpoint", string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => ({ key, released: false }),
      release: async () => {
        throw new Error("flush failed");
      },
    });
    const rt = await runFor(battery, {
      onError: (error, context) =>
        reports.push({ error, phase: context.phase }),
    }).ready;

    await rt.stop();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.phase).toBe("sub-cleanup");
    expect(reports[0]?.error).toBeInstanceOf(Error);
  });

  it("cannot hang forever on a release that never settles", async () => {
    const reports: Array<{ error: unknown; phase: string }> = [];
    const battery = defineManagedResource<"checkpoint", string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => ({ key, released: false }),
      release: () => new Promise<void>(() => {}),
    });
    const rt = await runFor(battery, {
      disposeTimeoutMs: 10,
      onError: (error, context) =>
        reports.push({ error, phase: context.phase }),
    }).ready;

    await rt.stop();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.phase).toBe("discard");
    expect(reports[0]?.error).toBeInstanceOf(DisposeTimeoutNotice);
  });
});
