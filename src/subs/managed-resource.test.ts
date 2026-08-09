import { describe, expect, it, vi } from "vitest";
import { defineMachine, type NoCtx, type Reducer, run } from "../index";
import {
  combineManagedResources,
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

function machineFor(
  battery: ReturnType<typeof defineManagedResource<string, Handle, NoCtx>>,
) {
  return defineMachine<State, Msg, never, ManagedResourceSub<string>, NoCtx>({
    init: () => [{ runId: "run-1" }, []],
    update,
    subscriptions: (s) => (s.runId === null ? [] : [battery.sub(s.runId)]),
    subscribe: { managed_resource: battery.subscribe },
  });
}

describe("defineManagedResource — acquire on appear, release on exit", () => {
  it("acquires when the Sub enters the desired set", async () => {
    const t = tracker();
    const battery = defineManagedResource<string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => t.acquire(key),
      release: (h) => t.release(h),
    });
    const rt = await run(machineFor(battery), {}).ready;

    expect(t.acquired).toEqual(["run-1"]);
    expect(t.released).toEqual([]);

    await rt.stop();
  });

  it("releases when the phase is left — the leak this battery kills", async () => {
    const t = tracker();
    const battery = defineManagedResource<string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => t.acquire(key),
      release: (h) => t.release(h),
    });
    const rt = await run(machineFor(battery), {}).ready;

    await rt.dispatch({ type: "finish" });
    expect(t.released).toHaveLength(1);
    expect(t.released[0]?.key).toBe("run-1");
    expect(t.released[0]?.released).toBe(true);

    await rt.stop();
  });

  it("a key change retires the old resource and acquires a fresh one", async () => {
    const t = tracker();
    const battery = defineManagedResource<string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => t.acquire(key),
      release: (h) => t.release(h),
    });
    const rt = await run(machineFor(battery), {}).ready;

    await rt.dispatch({ type: "switch", runId: "run-2" });
    expect(t.acquired).toEqual(["run-1", "run-2"]);
    expect(t.released.map((h) => h.key)).toEqual(["run-1"]);

    await rt.stop();
  });

  it("release receives the EXACT handle acquire returned", async () => {
    const handles: Handle[] = [];
    let releasedWith: Handle | null = null;
    const battery = defineManagedResource<string, Handle, NoCtx>({
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
    const rt = await run(machineFor(battery), {}).ready;

    await rt.dispatch({ type: "finish" });
    expect(releasedWith).toBe(handles[0]);

    await rt.stop();
  });

  it("get() reads the live handle while held, undefined once torn down", async () => {
    const t = tracker();
    const battery = defineManagedResource<string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => t.acquire(key),
      release: (h) => t.release(h),
    });
    const rt = await run(machineFor(battery), {}).ready;

    expect(battery.get("run-1")?.key).toBe("run-1");
    expect(battery.get("never-acquired")).toBeUndefined();

    await rt.dispatch({ type: "finish" });
    expect(battery.get("run-1")).toBeUndefined();

    await rt.stop();
  });

  it("get() returns the SAME owner the reconciler holds, not a rebuild", async () => {
    const built: Handle[] = [];
    const battery = defineManagedResource<string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => {
        const h = { key, released: false };
        built.push(h);
        return h;
      },
      release: () => {},
    });
    const rt = await run(machineFor(battery), {}).ready;

    expect(battery.get("run-1")).toBe(built[0]);
    expect(built).toHaveLength(1);

    await rt.stop();
  });

  it("an acquire that throws never produces a handle, so release never runs", async () => {
    const released: Handle[] = [];
    const battery = defineManagedResource<string, Handle, NoCtx>({
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
    await run(machineFor(battery), {}).ready.catch(() => undefined);

    expect(released).toEqual([]);
    expect(battery.get("run-1")).toBeUndefined();
  });

  it("a release that throws is swallowed at the boundary (Rule 2)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const battery = defineManagedResource<string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => ({ key, released: false }),
      release: () => {
        throw new Error("teardown failed");
      },
    });
    const rt = await run(machineFor(battery), {}).ready;

    await expect(rt.dispatch({ type: "finish" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    // Forgotten regardless: the handle table is cleaned before release runs.
    expect(battery.get("run-1")).toBeUndefined();

    warn.mockRestore();
    await rt.stop();
  });

  it("a rejected async release is logged, not surfaced as a Msg", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const battery = defineManagedResource<string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => ({ key, released: false }),
      release: () => Promise.reject(new Error("async teardown failed")),
    });
    const rt = await run(machineFor(battery), {}).ready;

    await expect(rt.dispatch({ type: "finish" })).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
    await rt.stop();
  });

  it("stop() releases a still-held resource", async () => {
    const t = tracker();
    const battery = defineManagedResource<string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => t.acquire(key),
      release: (h) => t.release(h),
    });
    const rt = await run(machineFor(battery), {}).ready;

    await rt.stop();
    expect(t.released.map((h) => h.key)).toEqual(["run-1"]);
  });

  it("subIdFor encodes the battery name, so two batteries never collide", () => {
    const a = defineManagedResource<string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => ({ key, released: false }),
      release: () => {},
    });
    const b = defineManagedResource<string, Handle, NoCtx>({
      name: "bridge",
      acquire: (key) => ({ key, released: false }),
      release: () => {},
    });
    expect(a.subIdFor("run-1")).not.toBe(b.subIdFor("run-1"));
  });

  it("keeps a string key and a numeric key distinct in the handle table", () => {
    const battery = defineManagedResource<string | number, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => ({ key: String(key), released: false }),
      release: () => {},
    });
    expect(battery.subIdFor("1")).not.toBe(battery.subIdFor(1));
  });
});

// ---------------------------------------------------------------------------

type MultiState = { readonly phase: "idle" | "running" | "reporting" };
type MultiMsg = { readonly type: "goto"; readonly phase: MultiState["phase"] };

const multiUpdate: Reducer<MultiState, MultiMsg, never> = {
  goto: (_s, m) => [{ phase: m.phase }, []],
};

describe("combineManagedResources — one cell, derived list and routing", () => {
  function twoResources() {
    const t = tracker();
    const checkpoint = defineManagedResource<string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => t.acquire(`checkpoint:${key}`),
      release: (h) => t.release(h),
    });
    const bridge = defineManagedResource<string, Handle, NoCtx>({
      name: "bridge",
      acquire: (key) => t.acquire(`bridge:${key}`),
      release: (h) => t.release(h),
    });
    const combined = combineManagedResources<MultiState, string, NoCtx>([
      // Each gate travels with its own resource — a new phase the gate does
      // not cover simply produces no sub.
      checkpoint.gated((s) => (s.phase === "running" ? "run-1" : null)),
      bridge.gated((s) =>
        s.phase === "running" || s.phase === "reporting" ? "run-1" : null,
      ),
    ]);
    return { t, checkpoint, bridge, combined };
  }

  function multiMachine(combined: ReturnType<typeof twoResources>["combined"]) {
    return defineMachine<
      MultiState,
      MultiMsg,
      never,
      ManagedResourceSub<string>,
      NoCtx
    >({
      init: () => [{ phase: "idle" }, []],
      update: multiUpdate,
      subscriptions: (s) => combined.subs(s),
      subscribe: { managed_resource: combined.subscribe },
    });
  }

  it("derives the active-sub list from each entry's own gate", () => {
    const { combined } = twoResources();
    expect(combined.subs({ phase: "idle" })).toHaveLength(0);
    expect(combined.subs({ phase: "running" })).toHaveLength(2);
    expect(combined.subs({ phase: "reporting" })).toHaveLength(1);
  });

  it("routes each Sub to the battery that owns it", async () => {
    const { t, combined } = twoResources();
    const rt = await run(multiMachine(combined), {}).ready;

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

  it("throws at construction on a duplicate battery name", () => {
    const a = defineManagedResource<string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => ({ key, released: false }),
      release: () => {},
    });
    const b = defineManagedResource<string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => ({ key, released: false }),
      release: () => {},
    });
    expect(() =>
      combineManagedResources<MultiState, string, NoCtx>([
        a.gated(() => "run-1"),
        b.gated(() => "run-1"),
      ]),
    ).toThrow(/duplicate managed-resource name "checkpoint"/);
  });

  it("throws loudly on an unrouted Sub id instead of installing a no-op", () => {
    const { combined } = twoResources();
    const stranger = defineManagedResource<string, Handle, NoCtx>({
      name: "stranger",
      acquire: (key) => ({ key, released: false }),
      release: () => {},
    });
    expect(() =>
      combined.subscribe(stranger.sub("run-1"), {}, () => {}),
    ).toThrow(/no battery for sub id/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// `.depKeyed` — the same acquire/release lifecycle as ONE `subs` entry. The
// simplification it unlocks: two managed resources used to collide on the
// single `subscribe.managed_resource` key, which is why
// `combineManagedResources` had to route by SubId. A dep-keyed Sub has its own
// reconcile slot, so two resources coexist with no combinator and no router.
// ───────────────────────────────────────────────────────────────────────────
describe("defineManagedResource.depKeyed — one subs entry, no router", () => {
  function depKeyedMachine(
    ...batteries: ReturnType<
      typeof defineManagedResource<string, Handle, NoCtx>
    >[]
  ) {
    return defineMachine<State, Msg, never, never, NoCtx>({
      init: () => [{ runId: "run-1" }, []],
      update,
      subs: batteries.map((b) => b.depKeyed((s: State) => s.runId)),
    });
  }

  it("acquires on arm and releases on the gate going null", async () => {
    const t = tracker();
    const battery = defineManagedResource<string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => t.acquire(key),
      release: (h) => t.release(h),
    });
    const rt = await run(depKeyedMachine(battery), {}).ready;
    expect(t.acquired).toEqual(["run-1"]);

    await rt.dispatch({ type: "finish" });
    expect(t.released.map((h) => h.key)).toEqual(["run-1"]);

    await rt.stop();
  });

  it("re-acquires on a key change, releasing the old handle first", async () => {
    const t = tracker();
    const battery = defineManagedResource<string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => t.acquire(key),
      release: (h) => t.release(h),
    });
    const rt = await run(depKeyedMachine(battery), {}).ready;

    await rt.dispatch({ type: "switch", runId: "run-2" });
    expect(t.acquired).toEqual(["run-1", "run-2"]);
    expect(t.released.map((h) => h.key)).toEqual(["run-1"]);

    await rt.stop();
  });

  it("keeps `get` pointing at the live handle the reconciler holds", async () => {
    const t = tracker();
    const battery = defineManagedResource<string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => t.acquire(key),
      release: (h) => t.release(h),
    });
    const rt = await run(depKeyedMachine(battery), {}).ready;

    const live = battery.get("run-1");
    expect(live?.key).toBe("run-1");
    expect(live?.released).toBe(false);

    await rt.dispatch({ type: "finish" });
    // Forgotten first, then released — and it is the SAME object `get` handed
    // out, so a Cmd handler reading through `get` holds the reconciler's owner
    // rather than a rebuild.
    expect(battery.get("run-1")).toBeUndefined();
    expect(t.released).toEqual([live]);
    expect(live?.released).toBe(true);

    await rt.stop();
  });

  it("two resources coexist with NO combinator — each owns its own slot", async () => {
    const a = tracker();
    const b = tracker();
    const first = defineManagedResource<string, Handle, NoCtx>({
      name: "checkpoint",
      acquire: (key) => a.acquire(key),
      release: (h) => a.release(h),
    });
    const second = defineManagedResource<string, Handle, NoCtx>({
      name: "bridge",
      acquire: (key) => b.acquire(key),
      release: (h) => b.release(h),
    });

    const rt = await run(depKeyedMachine(first, second), {}).ready;
    // Under the manual path both subs share `type: "managed_resource"`, so this
    // needed `combineManagedResources` to route by SubId. Here: two slots.
    expect(a.acquired).toEqual(["run-1"]);
    expect(b.acquired).toEqual(["run-1"]);

    await rt.dispatch({ type: "finish" });
    expect(a.released.map((h) => h.key)).toEqual(["run-1"]);
    expect(b.released.map((h) => h.key)).toEqual(["run-1"]);

    await rt.stop();
  });
});
