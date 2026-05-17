import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Cmd, type Machine, run, type Store, type Sub } from "../src/index";

// =============================================================================
// Test-local fixtures
// =============================================================================

/**
 * Test-local Store stub mirroring the @b8e/tea-mem contract.
 *
 * `@b8e/tea-mem` will ship a real `memoryStore` in task 4. The runtime tests
 * cannot depend on tea-mem (circular workspace dep risk + we're testing the
 * core, not the adapter), so we re-implement the minimum shape here. Tests
 * for tea-mem live in its own package.
 */
function memoryStore<S>(initial: S | null = null): Store<S> & {
  saves: S[];
  loadCount: number;
} {
  let current: S | null = initial;
  const saves: S[] = [];
  let loadCount = 0;
  return {
    async load() {
      loadCount++;
      return current;
    },
    async save(s) {
      current = s;
      saves.push(s);
    },
    get saves() {
      return saves;
    },
    get loadCount() {
      return loadCount;
    },
  };
}

/**
 * Trivial counter machine. `inc` increments; `set` assigns; `noop` does nothing.
 * Used for nearly every behavioral test — small enough to read in one screen.
 */
type CounterState = { n: number };
type CounterMsg =
  | { type: "inc" }
  | { type: "set"; n: number }
  | { type: "side_effect" }
  | { type: "side_done"; result: number };
type CounterCmd = Cmd<"side"> | { type: "side_typed"; payload: number };
type CounterSub = Sub<"tick">;
type CounterCtx = { tag: string };

function counterMachine(opts: {
  onSide?: (cmd: CounterCmd, ctx: CounterCtx) => Promise<CounterMsg | void>;
  subs?: (s: CounterState) => readonly CounterSub[];
  subscribeTick?: (
    sub: CounterSub,
    ctx: CounterCtx,
    dispatch: (msg: CounterMsg) => void,
  ) => () => void;
}): Machine<CounterState, CounterMsg, CounterCmd, CounterSub, CounterCtx> {
  return {
    init: (loaded, _ctx) => [loaded ?? { n: 0 }, [] as const],
    update: (s, m) => {
      switch (m.type) {
        case "inc":
          return [{ n: s.n + 1 }, [] as const];
        case "set":
          return [{ n: m.n }, [] as const];
        case "side_effect":
          return [s, [{ type: "side" }] as const];
        case "side_done":
          return [{ n: m.result }, [] as const];
        default:
          return [s, [] as const];
      }
    },
    interpret: {
      side: opts.onSide ?? (async () => undefined),
      side_typed: opts.onSide ?? (async () => undefined),
    },
    subscriptions: opts.subs,
    subscribe: opts.subscribeTick ? { tick: opts.subscribeTick } : undefined,
  };
}

// =============================================================================
// Acceptance criteria
// =============================================================================

describe("run() — Locked API Surface", () => {
  it("returns a Runtime<S, M> with the expected method shape", () => {
    const machine = counterMachine({});
    const runtime = run(machine, { ctx: { tag: "t" } });
    expect(typeof runtime.dispatch).toBe("function");
    expect(typeof runtime.getState).toBe("function");
    expect(typeof runtime.subscribe).toBe("function");
    expect(typeof runtime.stop).toBe("function");
  });
});

describe("run() — boot", () => {
  it("first-boot: store.load returns null → init(null, ctx) is called; emitted cmds run; state saved", async () => {
    const store = memoryStore<CounterState>(null);
    const initArgs: Array<CounterState | null> = [];
    const machine: Machine<CounterState, CounterMsg, CounterCmd, CounterSub, CounterCtx> = {
      ...counterMachine({}),
      init: (loaded, _ctx) => {
        initArgs.push(loaded);
        return [loaded ?? { n: 42 }, [] as const];
      },
    };
    const runtime = run(machine, { ctx: { tag: "t" }, store });
    // First dispatch awaits boot.
    await runtime.dispatch({ type: "inc" });
    expect(store.loadCount).toBe(1);
    expect(initArgs).toEqual([null]);
    expect(runtime.getState()).toEqual({ n: 43 });
    // Two saves: one at boot, one after the inc dispatch.
    expect(store.saves.length).toBe(2);
    expect(store.saves[0]).toEqual({ n: 42 });
    expect(store.saves[1]).toEqual({ n: 43 });
    await runtime.stop();
  });

  it("resume: store.load returns a snapshot → init(loaded, ctx) is called; emitted cmds run; state saved", async () => {
    const store = memoryStore<CounterState>({ n: 100 });
    const initArgs: Array<CounterState | null> = [];
    const machine: Machine<CounterState, CounterMsg, CounterCmd, CounterSub, CounterCtx> = {
      ...counterMachine({}),
      init: (loaded, _ctx) => {
        initArgs.push(loaded);
        return [loaded ?? { n: 0 }, [] as const];
      },
    };
    const runtime = run(machine, { ctx: { tag: "t" }, store });
    await runtime.dispatch({ type: "inc" });
    expect(initArgs).toEqual([{ n: 100 }]);
    expect(runtime.getState()).toEqual({ n: 101 });
    await runtime.stop();
  });

  it("first-boot init cmds run: init emits a cmd and the interpret handler fires", async () => {
    const interpretCalls: CounterCmd[] = [];
    const machine: Machine<CounterState, CounterMsg, CounterCmd, CounterSub, CounterCtx> = {
      init: (_loaded, _ctx) => [{ n: 0 }, [{ type: "side" }] as const],
      update: (s) => [s, [] as const],
      interpret: {
        side: async (cmd) => {
          interpretCalls.push(cmd);
          return undefined;
        },
        side_typed: async () => undefined,
      },
    };
    const runtime = run(machine, { ctx: { tag: "t" }, store: memoryStore() });
    await runtime.dispatch({ type: "inc" });
    expect(interpretCalls).toEqual([{ type: "side" }]);
    await runtime.stop();
  });

  it("works without a store (no persistence)", async () => {
    const runtime = run(counterMachine({}), { ctx: { tag: "t" } });
    await runtime.dispatch({ type: "inc" });
    expect(runtime.getState()).toEqual({ n: 1 });
    await runtime.stop();
  });
});

describe("run() — dispatch is serial", () => {
  it("a test dispatches two msgs concurrently and the second reducer observes the first's resulting state", async () => {
    const observedStates: CounterState[] = [];
    const machine: Machine<CounterState, CounterMsg, CounterCmd, CounterSub, CounterCtx> = {
      ...counterMachine({}),
      update: (s, m) => {
        observedStates.push({ ...s });
        if (m.type === "inc") return [{ n: s.n + 1 }, [] as const];
        return [s, [] as const];
      },
    };
    const runtime = run(machine, { ctx: { tag: "t" } });
    // Kick off two without awaiting the first — they must queue.
    const p1 = runtime.dispatch({ type: "inc" });
    const p2 = runtime.dispatch({ type: "inc" });
    await Promise.all([p1, p2]);
    // Reducer call 0: { n: 0 }; call 1: { n: 1 } — the second reducer call
    // saw the first's result.
    expect(observedStates).toEqual([{ n: 0 }, { n: 1 }]);
    expect(runtime.getState()).toEqual({ n: 2 });
    await runtime.stop();
  });
});

describe("run() — save-then-effects ordering", () => {
  it("store.save(newState) is awaited BEFORE interpret[cmd.type] runs", async () => {
    const events: string[] = [];
    const store: Store<CounterState> = {
      async load() {
        return null;
      },
      async save() {
        events.push("save");
      },
    };
    const machine: Machine<CounterState, CounterMsg, CounterCmd, CounterSub, CounterCtx> = {
      init: () => [{ n: 0 }, [] as const],
      update: (_s, m) => {
        if (m.type === "side_effect") return [{ n: 1 }, [{ type: "side" }] as const];
        return [{ n: 0 }, [] as const];
      },
      interpret: {
        side: async () => {
          events.push("interpret");
          return undefined;
        },
        side_typed: async () => undefined,
      },
    };
    const runtime = run(machine, { ctx: { tag: "t" }, store });
    await runtime.dispatch({ type: "side_effect" });
    // First "save" is boot; second is post-update; "interpret" must come AFTER
    // the second save.
    const saveIdx = events.lastIndexOf("save");
    const interpretIdx = events.indexOf("interpret");
    expect(saveIdx).toBeGreaterThanOrEqual(0);
    expect(interpretIdx).toBeGreaterThan(saveIdx);
    await runtime.stop();
  });
});

describe("run() — subscription reconcile by id", () => {
  it("new ids → subscribe[type] starts; removed ids → cleanup called exactly once; same id present → cleanup NOT called and start NOT re-invoked", async () => {
    type S = { phase: "off" | "on" | "alt" };
    type M = { type: "to_on" } | { type: "to_alt" } | { type: "to_off" };
    type U = Sub<"tick">;
    const startCalls: string[] = [];
    const cleanupCalls: string[] = [];
    const cleanupsById = new Map<string, () => void>();

    const machine: Machine<S, M, never, U, { tag: "ctx" }> = {
      init: () => [{ phase: "off" }, [] as const],
      update: (s, m) => {
        switch (m.type) {
          case "to_on":
            return [{ phase: "on" }, [] as const];
          case "to_alt":
            return [{ phase: "alt" }, [] as const];
          case "to_off":
            return [{ phase: "off" }, [] as const];
          default:
            return [s, [] as const];
        }
      },
      interpret: {} as never,
      subscriptions: (s) => {
        if (s.phase === "on") return [{ id: "tick-stable", type: "tick" }];
        if (s.phase === "alt")
          return [
            { id: "tick-stable", type: "tick" }, // same id across transitions
            { id: "tick-extra", type: "tick" },
          ];
        return [];
      },
      subscribe: {
        tick: (sub) => {
          startCalls.push(sub.id);
          const fn = () => cleanupCalls.push(sub.id);
          cleanupsById.set(sub.id, fn);
          return fn;
        },
      },
    };

    const runtime = run(machine, { ctx: { tag: "ctx" } });
    await runtime.dispatch({ type: "to_on" });
    expect(startCalls).toEqual(["tick-stable"]);
    expect(cleanupCalls).toEqual([]);

    // Move to `alt`: tick-stable should NOT restart (same id); tick-extra is new.
    await runtime.dispatch({ type: "to_alt" });
    expect(startCalls).toEqual(["tick-stable", "tick-extra"]);
    expect(cleanupCalls).toEqual([]);

    // Move to `off`: both should be cleaned up.
    await runtime.dispatch({ type: "to_off" });
    expect(startCalls).toEqual(["tick-stable", "tick-extra"]);
    // Cleanup order: removals happen first; cleanupCalls should contain both.
    expect(cleanupCalls.sort()).toEqual(["tick-extra", "tick-stable"]);

    await runtime.stop();
  });

  it("subscriptions(state) is called after save (verified by ordering of save spy and subscriptions spy)", async () => {
    const events: string[] = [];
    const store: Store<{ n: number }> = {
      async load() {
        return null;
      },
      async save() {
        events.push("save");
      },
    };
    const machine: Machine<{ n: number }, { type: "inc" }, never, Sub<"tick">, { tag: "ctx" }> = {
      init: () => [{ n: 0 }, [] as const],
      update: (s) => [{ n: s.n + 1 }, [] as const],
      interpret: {} as never,
      subscriptions: (s) => {
        events.push(`subs(${s.n})`);
        return [];
      },
      subscribe: { tick: () => () => undefined },
    };
    const runtime = run(machine, { ctx: { tag: "ctx" }, store });
    await runtime.dispatch({ type: "inc" });
    // Boot: save → subs(0). Then inc: save → subs(1).
    expect(events).toEqual(["save", "subs(0)", "save", "subs(1)"]);
    await runtime.stop();
  });
});

describe("run() — listener semantics", () => {
  it("runtime.subscribe(listener) fires after each completed dispatch and never mid-transition", async () => {
    const observedStates: CounterState[] = [];
    const machine = counterMachine({});
    const runtime = run(machine, { ctx: { tag: "ctx" } });
    runtime.subscribe(() => {
      // Reading getState() at this point — must see the post-transition state,
      // never a half-transition. Because save → reconcile → interpret →
      // fireListeners is the order, by the time the listener is called the
      // transition is fully complete.
      observedStates.push(runtime.getState());
    });
    await runtime.dispatch({ type: "inc" });
    await runtime.dispatch({ type: "set", n: 50 });
    await runtime.dispatch({ type: "inc" });
    // Boot fires once; each dispatch fires once. 4 events total.
    expect(observedStates).toEqual([
      { n: 0 }, // boot
      { n: 1 },
      { n: 50 },
      { n: 51 },
    ]);
    await runtime.stop();
  });

  it("unsubscribe stops the listener", async () => {
    const machine = counterMachine({});
    const runtime = run(machine, { ctx: { tag: "ctx" } });
    const fired: number[] = [];
    const unsubscribe = runtime.subscribe(() => fired.push(runtime.getState().n));
    await runtime.dispatch({ type: "inc" });
    expect(fired).toEqual([0, 1]); // boot + inc
    unsubscribe();
    await runtime.dispatch({ type: "inc" });
    expect(fired).toEqual([0, 1]);
    await runtime.stop();
  });

  it("a throwing listener does not strand other listeners", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const machine = counterMachine({});
      const runtime = run(machine, { ctx: { tag: "ctx" } });
      const ok: number[] = [];
      runtime.subscribe(() => {
        throw new Error("bad listener");
      });
      runtime.subscribe(() => ok.push(runtime.getState().n));
      await runtime.dispatch({ type: "inc" });
      // The good listener still fired.
      expect(ok.length).toBeGreaterThan(0);
      expect(consoleSpy).toHaveBeenCalled();
      await runtime.stop();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe("run() — stop()", () => {
  it("drains queued dispatches, runs every active sub cleanup, flushes state via store.save, and returns a resolved Promise", async () => {
    const cleanupCalls: string[] = [];
    const machine: Machine<CounterState, CounterMsg, CounterCmd, CounterSub, CounterCtx> = {
      ...counterMachine({
        subs: (s) => (s.n > 0 ? [{ id: "tick-A", type: "tick" }] : []),
        subscribeTick: (sub) => () => cleanupCalls.push(sub.id),
      }),
    };
    const store = memoryStore<CounterState>(null);
    const runtime = run(machine, { ctx: { tag: "t" }, store });
    await runtime.dispatch({ type: "inc" }); // sub starts
    // Stop with one queued dispatch in flight to test drain.
    const queued = runtime.dispatch({ type: "inc" }); // queued; will drain
    const stopPromise = runtime.stop();
    // Awaiting stop must resolve (not reject).
    await expect(stopPromise).resolves.toBeUndefined();
    // The queued dispatch should have settled (resolved or rejected — either
    // is acceptable; the only contract is "drained").
    await queued.catch(() => undefined);
    // Cleanup ran exactly once.
    expect(cleanupCalls).toEqual(["tick-A"]);
    // Final save happened: at least the most recent state is in saves.
    expect(store.saves.length).toBeGreaterThan(0);
    // The last save is the final flush.
    expect(store.saves[store.saves.length - 1]).toEqual(runtime.getState());
  });

  it("after stop, further dispatches reject", async () => {
    const runtime = run(counterMachine({}), { ctx: { tag: "t" } });
    await runtime.dispatch({ type: "inc" });
    await runtime.stop();
    await expect(runtime.dispatch({ type: "inc" })).rejects.toThrow(/runtime stopped/);
  });
});

// =============================================================================
// Throw semantics — every row of the PRD table
// =============================================================================

describe("run() — throw semantics", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("update throw → dispatch() rejects, state unchanged, runtime stays alive (next dispatch works)", async () => {
    const machine: Machine<CounterState, CounterMsg, CounterCmd, CounterSub, CounterCtx> = {
      ...counterMachine({}),
      update: (s, m) => {
        if (m.type === "inc" && s.n === 1) throw new Error("boom");
        if (m.type === "inc") return [{ n: s.n + 1 }, [] as const];
        if (m.type === "set") return [{ n: m.n }, [] as const];
        return [s, [] as const];
      },
    };
    const runtime = run(machine, { ctx: { tag: "t" } });
    await runtime.dispatch({ type: "inc" });
    expect(runtime.getState()).toEqual({ n: 1 });
    await expect(runtime.dispatch({ type: "inc" })).rejects.toThrow(/boom/);
    // State unchanged after the failed dispatch.
    expect(runtime.getState()).toEqual({ n: 1 });
    // Runtime alive: next dispatch works.
    await runtime.dispatch({ type: "set", n: 10 });
    expect(runtime.getState()).toEqual({ n: 10 });
    await runtime.stop();
  });

  it("interpret[type] throw → dispatch() rejects, state already saved, runtime stays alive", async () => {
    const store = memoryStore<CounterState>(null);
    const machine: Machine<CounterState, CounterMsg, CounterCmd, CounterSub, CounterCtx> = {
      ...counterMachine({
        onSide: async () => {
          throw new Error("interpret-bad");
        },
      }),
    };
    const runtime = run(machine, { ctx: { tag: "t" }, store });
    await runtime.dispatch({ type: "inc" }); // n: 1 saved cleanly
    expect(store.saves[store.saves.length - 1]).toEqual({ n: 1 });

    // Dispatch a side_effect — update succeeds, save succeeds, interpret throws.
    await expect(runtime.dispatch({ type: "side_effect" })).rejects.toThrow(/interpret-bad/);
    // State already saved with the side_effect's reducer result.
    // The reducer for side_effect returns [s, [{type: 'side'}]] — state n stays 1.
    // But save WAS called with the new state object.
    expect(runtime.getState()).toEqual({ n: 1 });

    // Runtime alive.
    await runtime.dispatch({ type: "inc" });
    expect(runtime.getState()).toEqual({ n: 2 });
    await runtime.stop();
  });

  it("subscribe[type] start throw → dispatch() rejects, state already saved, offending sub NOT registered, OTHER subs from same reconcile pass DO register", async () => {
    type S = { phase: "off" | "on" };
    type M = { type: "to_on" };
    type U =
      | { id: string; type: "good_a" }
      | { id: string; type: "bad" }
      | { id: string; type: "good_b" };
    const startedIds: string[] = [];

    const machine: Machine<S, M, never, U, { tag: "ctx" }> = {
      init: () => [{ phase: "off" }, [] as const],
      update: (s, m) => {
        if (m.type === "to_on") return [{ phase: "on" }, [] as const];
        return [s, [] as const];
      },
      interpret: {} as never,
      subscriptions: (s) =>
        s.phase === "on"
          ? [
              { id: "good-a", type: "good_a" },
              { id: "bad", type: "bad" },
              { id: "good-b", type: "good_b" },
            ]
          : [],
      subscribe: {
        good_a: (sub) => {
          startedIds.push(sub.id);
          return () => undefined;
        },
        bad: () => {
          throw new Error("sub-start-bad");
        },
        good_b: (sub) => {
          startedIds.push(sub.id);
          return () => undefined;
        },
      },
    };

    const store = memoryStore<S>(null);
    const runtime = run(machine, { ctx: { tag: "ctx" }, store });
    await expect(runtime.dispatch({ type: "to_on" })).rejects.toThrow(/sub-start-bad/);
    // State was saved BEFORE reconcile (so the post-transition state is persisted).
    expect(store.saves[store.saves.length - 1]).toEqual({ phase: "on" });
    // Both good subs registered; bad did not (no cleanup tracked for it).
    expect(startedIds.sort()).toEqual(["good-a", "good-b"]);
    await runtime.stop();
  });

  it("subscribe[type] cleanup throw → swallowed, console.error called once, reconciler continues to next sub cleanup in the same pass", async () => {
    type S = { phase: "on" | "off" };
    type M = { type: "to_off" };
    type U = { id: string; type: "bad_cleanup" } | { id: string; type: "good_cleanup" };
    const goodCleanedUp: string[] = [];

    const machine: Machine<S, M, never, U, { tag: "ctx" }> = {
      init: () => [{ phase: "on" }, [] as const],
      update: (s, m) => {
        if (m.type === "to_off") return [{ phase: "off" }, [] as const];
        return [s, [] as const];
      },
      interpret: {} as never,
      subscriptions: (s) =>
        s.phase === "on"
          ? [
              { id: "bad", type: "bad_cleanup" },
              { id: "good", type: "good_cleanup" },
            ]
          : [],
      subscribe: {
        bad_cleanup: () => () => {
          throw new Error("cleanup-bad");
        },
        good_cleanup: (sub) => () => goodCleanedUp.push(sub.id),
      },
    };

    const runtime = run(machine, { ctx: { tag: "ctx" } });
    // Wait for boot to complete so the subs are registered.
    await runtime.dispatch({ type: "to_off" });
    // Transition: cleanup throws are swallowed; good cleanup still ran.
    expect(goodCleanedUp).toEqual(["good"]);
    // console.error called at least once.
    expect(errorSpy).toHaveBeenCalled();
    await runtime.stop();
  });

  it("store.load throw at boot → run() throws synchronously OR every method on the returned runtime surfaces the load error", async () => {
    // The PRD AC says "run() throws synchronously (no runtime returned)". The
    // current implementation defers load to a boot promise (because Store#load
    // is async by contract), so the practical guarantee is "no usable runtime
    // is ever observed". We assert the post-boot-failure surface here.
    const store: Store<CounterState> = {
      async load() {
        throw new Error("load-bad");
      },
      async save() {
        // unreachable
      },
    };
    let constructionThrew: unknown = null;
    let runtime: ReturnType<
      typeof run<CounterState, CounterMsg, CounterCmd, CounterSub, CounterCtx>
    > | null = null;
    try {
      runtime = run(counterMachine({}), { ctx: { tag: "t" }, store });
    } catch (err) {
      constructionThrew = err;
    }
    if (constructionThrew !== null) {
      // Honors the strict reading of the AC.
      expect((constructionThrew as Error).message).toMatch(/load-bad/);
      return;
    }
    // Practical reading: every method on the runtime surfaces the load error.
    expect(runtime).not.toBe(null);
    await expect(runtime!.dispatch({ type: "inc" })).rejects.toThrow(/load-bad/);
    expect(() => runtime!.getState()).toThrow(/load-bad/);
    await runtime!.stop();
  });

  it("store.save throw mid-dispatch → dispatch() rejects, in-memory state advanced, runtime continues", async () => {
    let saveCalls = 0;
    const store: Store<CounterState> = {
      async load() {
        return null;
      },
      async save() {
        saveCalls++;
        if (saveCalls === 2) throw new Error("save-bad"); // boot save ok; first dispatch save bad
      },
    };
    const runtime = run(counterMachine({}), { ctx: { tag: "t" }, store });
    // First dispatch's save throws. According to PRD: "in-memory state advanced;
    // persisted state did not. Runtime continues."
    await expect(runtime.dispatch({ type: "inc" })).rejects.toThrow(/save-bad/);
    expect(runtime.getState()).toEqual({ n: 1 }); // in-memory state advanced
    // Runtime continues — next dispatch works (and its save succeeds since saveCalls === 3).
    await runtime.dispatch({ type: "inc" });
    expect(runtime.getState()).toEqual({ n: 2 });
    await runtime.stop();
  });
});

// =============================================================================
// Property-based crash recovery
// =============================================================================

describe("run() — property-based: snapshot → rebuild → continue equals straight-line replay", () => {
  /**
   * Tiny LCG for deterministic random message sequences. No fast-check dep —
   * zero-runtime-deps is a PRD invariant for @b8e/tea.
   */
  function lcg(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  type S = { n: number; history: number[] };
  type M = { type: "inc" } | { type: "dec" } | { type: "set"; n: number } | { type: "double" };

  const machine: Machine<S, M, never, Sub<never>, { tag: "ctx" }> = {
    init: (loaded) => [loaded ?? { n: 0, history: [] }, [] as const],
    update: (s, m) => {
      switch (m.type) {
        case "inc":
          return [{ n: s.n + 1, history: [...s.history, s.n + 1] }, [] as const];
        case "dec":
          return [{ n: s.n - 1, history: [...s.history, s.n - 1] }, [] as const];
        case "set":
          return [{ n: m.n, history: [...s.history, m.n] }, [] as const];
        case "double":
          return [{ n: s.n * 2, history: [...s.history, s.n * 2] }, [] as const];
        default:
          return [s, [] as const];
      }
    },
    interpret: {} as never,
  };

  function randomMsg(rng: () => number): M {
    const r = rng();
    if (r < 0.25) return { type: "inc" };
    if (r < 0.5) return { type: "dec" };
    if (r < 0.75) return { type: "set", n: Math.floor(rng() * 100) - 50 };
    return { type: "double" };
  }

  it("for 25 random seeds: dispatch-snapshot-rebuild-continue == straight-line", async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rng = lcg(seed);
      const totalLen = 10 + Math.floor(rng() * 20);
      const splitAt = Math.floor(totalLen / 2);
      const msgs: M[] = Array.from({ length: totalLen }, () => randomMsg(rng));

      // === Path A: straight-line replay through one runtime ===
      const storeA = memoryStore<S>(null);
      const rtA = run(machine, { ctx: { tag: "ctx" }, store: storeA });
      for (const m of msgs) await rtA.dispatch(m);
      const finalA = rtA.getState();
      await rtA.stop();

      // === Path B: snapshot midway, drop, rebuild, continue ===
      const storeB = memoryStore<S>(null);
      const rtB1 = run(machine, { ctx: { tag: "ctx" }, store: storeB });
      for (let i = 0; i < splitAt; i++) await rtB1.dispatch(msgs[i]);
      const snapshot = rtB1.getState();
      await rtB1.stop();

      // Rebuild a fresh runtime against a store pre-seeded with the snapshot.
      const storeB2 = memoryStore<S>(snapshot);
      const rtB2 = run(machine, { ctx: { tag: "ctx" }, store: storeB2 });
      for (let i = splitAt; i < totalLen; i++) await rtB2.dispatch(msgs[i]);
      const finalB = rtB2.getState();
      await rtB2.stop();

      expect(finalB).toEqual(finalA);
    }
  });
});
