import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DispatchDiscardedError,
  defineMachine,
  type Reducer,
  replay,
  type Sub,
  type Subscribe,
  subIdOf,
  type TimerSub,
} from "./index";
import { run } from "./promise";

// ───────────────────────────────────────────────────────────────────────────
// Subs as data (#279, #251 R1.4, spike #252). A machine declares
// `subs: [{ type, deps(state) }]`; the engine derives the id
// (`structuralHash({ type, deps })`) and the gate (`deps` nullish ⇒ off), and
// runs each Sub through the `subscribe[type]` runner handed to `run` — or the
// engine's built-in `timer`. What is pinned here is the reconcile contract
// (start / leave alone / restart / stop), the built-in timer, and a user runner
// overriding it.
// ───────────────────────────────────────────────────────────────────────────

type State = { readonly runId: string | null; readonly phase: "idle" | "live" };
type Msg =
  | { readonly type: "start"; readonly runId: string }
  | { readonly type: "rekey"; readonly runId: string }
  | { readonly type: "stop" }
  | { readonly type: "noop" };
type RunSub = Sub<"run", { readonly runId: string | null }>;

const idle: State = { runId: null, phase: "idle" };

const update: Reducer<State, Msg, never> = {
  start: (_s, m) => [{ runId: m.runId, phase: "live" }, []],
  rekey: (s, m) => [{ ...s, runId: m.runId }, []],
  stop: () => [{ runId: null, phase: "idle" }, []],
  noop: (s) => [s, []],
};

const machine = defineMachine({
  types: { model: {} as State, msg: {} as Msg, sub: {} as RunSub },
  init: () => [idle, []],
  update,
  subs: [
    {
      type: "run",
      deps: (s) => (s.phase === "live" ? { runId: s.runId } : null),
    },
  ],
});

// A runner that logs every start and every stop, so the reconcile decisions
// are observable rather than inferred.
function recording(log: string[]): Subscribe<Msg, RunSub, unknown> {
  return {
    run: (sub) => {
      log.push(`start:${sub.deps.runId}`);
      return () => {
        log.push(`stop:${sub.deps.runId}`);
      };
    },
  };
}

describe("subs as data — the reconcile contract", () => {
  it("starts when `deps` turns non-null and stops when it goes null", async () => {
    const log: string[] = [];
    const rt = await run(machine, { subscribe: recording(log) }).ready;
    expect(log).toEqual([]);

    await rt.dispatch({ type: "start", runId: "r1" });
    expect(log).toEqual(["start:r1"]);

    await rt.dispatch({ type: "stop" });
    expect(log).toEqual(["start:r1", "stop:r1"]);
  });

  it("leaves a running Sub alone while `deps` is unchanged", async () => {
    const log: string[] = [];
    const rt = await run(machine, { subscribe: recording(log) }).ready;

    await rt.dispatch({ type: "start", runId: "r1" });
    await rt.dispatch({ type: "noop" });
    await rt.dispatch({ type: "rekey", runId: "r1" });

    expect(log).toEqual(["start:r1"]);
  });

  it("restarts on a `deps` change: the old one stops before the new one starts", async () => {
    const log: string[] = [];
    const rt = await run(machine, { subscribe: recording(log) }).ready;

    await rt.dispatch({ type: "start", runId: "r1" });
    await rt.dispatch({ type: "rekey", runId: "r2" });

    expect(log).toEqual(["start:r1", "stop:r1", "start:r2"]);
  });

  it("stops every running Sub on stop(), once", async () => {
    const log: string[] = [];
    const rt = await run(machine, { subscribe: recording(log) }).ready;

    await rt.dispatch({ type: "start", runId: "r1" });
    await rt.stop();
    expect(log).toEqual(["start:r1", "stop:r1"]);

    await rt.stop();
    expect(log).toEqual(["start:r1", "stop:r1"]);
  });

  it("hands the runner the derived id, the type and the deps value", async () => {
    const seen: Sub[] = [];
    const rt = await run(machine, {
      subscribe: {
        run: (sub) => {
          seen.push(sub);
          return () => {};
        },
      },
    }).ready;

    await rt.dispatch({ type: "start", runId: "r1" });
    expect(seen).toEqual([
      {
        id: subIdOf("run", { runId: "r1" }),
        type: "run",
        deps: { runId: "r1" },
      },
    ]);
    await rt.stop();
  });

  it("a constant `deps` is a Sub that runs for the machine's life", async () => {
    type Beat = Sub<"beat", { readonly name: string }>;
    const log: string[] = [];
    const beating = defineMachine({
      types: { model: {} as State, msg: {} as Msg, sub: {} as Beat },
      init: () => [idle, []],
      update,
      subs: [{ type: "beat", deps: () => ({ name: "main" }) }],
    });
    const rt = await run(beating, {
      subscribe: {
        beat: (sub) => {
          log.push(`start:${sub.deps.name}`);
          return () => {
            log.push("stop");
          };
        },
      },
    }).ready;

    await rt.dispatch({ type: "start", runId: "r1" });
    await rt.dispatch({ type: "stop" });
    expect(log).toEqual(["start:main"]);

    await rt.stop();
    expect(log).toEqual(["start:main", "stop"]);
  });

  it("`undefined` deps mean off, exactly like null", async () => {
    type OptState = { readonly runId?: string };
    type OptMsg =
      | { readonly type: "set"; readonly runId: string }
      | { readonly type: "clear" };
    type OptSub = Sub<"opt", string>;
    const log: string[] = [];
    const opt = defineMachine({
      types: { model: {} as OptState, msg: {} as OptMsg, sub: {} as OptSub },
      init: () => [{}, []],
      update: {
        set: (_s, m) => [{ runId: m.runId }, []],
        clear: () => [{}, []],
      } satisfies Reducer<OptState, OptMsg, never>,
      subs: [{ type: "opt", deps: (s) => s.runId }],
    });
    const rt = await run(opt, {
      subscribe: {
        opt: (sub) => {
          log.push(`start:${sub.deps}`);
          return () => {
            log.push(`stop:${sub.deps}`);
          };
        },
      },
    }).ready;
    expect(log).toEqual([]);

    await rt.dispatch({ type: "set", runId: "r1" });
    await rt.dispatch({ type: "clear" });
    expect(log).toEqual(["start:r1", "stop:r1"]);
  });
});

describe("subs as data — a runner's dispatch", () => {
  it("queues its transition behind the runner, never on the runner's own stack", async () => {
    const order: string[] = [];
    const rt = await run(machine, {
      subscribe: {
        run: (sub, _ctx, dispatch) => {
          if (sub.deps.runId === "r1") {
            dispatch({ type: "rekey", runId: "r2" });
            order.push("runner returned");
          }
          return () => {};
        },
      },
    }).ready;
    rt.observe((msg) => {
      if (msg.type === "rekey") order.push("rekey applied");
    });

    await rt.dispatch({ type: "start", runId: "r1" });
    await rt.idle();
    expect(order).toEqual(["runner returned", "rekey applied"]);
    expect(rt.getState().runId).toBe("r2");
  });

  it("a dispatch during teardown reaches the sink as a discard, not the host", async () => {
    const reports: Array<{ error: unknown; phase: string }> = [];
    let fire: (() => void) | undefined;
    const rt = await run(machine, {
      subscribe: {
        run: (_sub, _ctx, dispatch) => {
          fire = () => dispatch({ type: "noop" });
          return () => {};
        },
      },
      onError: (error, context) =>
        reports.push({ error, phase: context.phase }),
    }).ready;
    await rt.dispatch({ type: "start", runId: "r1" });

    const stopping = rt.stop();
    fire?.();
    await stopping;

    expect(reports).toHaveLength(1);
    expect(reports[0]?.phase).toBe("discard");
    expect(reports[0]?.error).toBeInstanceOf(DispatchDiscardedError);
  });
});

describe("subs as data — failures are isolated and surfaced", () => {
  type Two = RunSub | Sub<"other", { readonly runId: string | null }>;
  function two(deps: (s: State) => { readonly runId: string | null } | null) {
    return defineMachine({
      types: { model: {} as State, msg: {} as Msg, sub: {} as Two },
      init: () => [idle, []],
      update,
      subs: [
        { type: "other", deps },
        {
          type: "run",
          deps: (s) => (s.phase === "live" ? { runId: s.runId } : null),
        },
      ],
    });
  }
  const live = (s: State) => (s.phase === "live" ? { runId: s.runId } : null);

  it("a throwing runner does not strand its siblings, and the throw surfaces", async () => {
    const log: string[] = [];
    const rt = await run(two(live), {
      subscribe: {
        ...recording(log),
        other: () => {
          throw new Error("runner failed");
        },
      },
    }).ready;

    await expect(rt.dispatch({ type: "start", runId: "r1" })).rejects.toThrow(
      "runner failed",
    );
    expect(log).toEqual(["start:r1"]);
  });

  it("a throwing `deps` does not strand its siblings, and the throw surfaces", async () => {
    const log: string[] = [];
    const rt = await run(
      two((s) => {
        if (s.phase === "live") throw new Error("deps failed");
        return null;
      }),
      { subscribe: { ...recording(log), other: () => () => {} } },
    ).ready;

    await expect(rt.dispatch({ type: "start", runId: "r1" })).rejects.toThrow(
      "deps failed",
    );
    expect(log).toEqual(["start:r1"]);
  });

  it("a throwing Dispose is routed to onError, and the restart still happens", async () => {
    const log: string[] = [];
    const onError = vi.fn();
    const rt = await run(machine, {
      subscribe: {
        run: (sub) => {
          log.push(`start:${sub.deps.runId}`);
          return () => {
            throw new Error("dispose failed");
          };
        },
      },
      onError,
    }).ready;

    await rt.dispatch({ type: "start", runId: "r1" });
    await rt.dispatch({ type: "rekey", runId: "r2" });

    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      phase: "sub-cleanup",
    });
    expect(log).toEqual(["start:r1", "start:r2"]);
  });

  it("a Sub type with no runner fails loudly instead of never starting", async () => {
    const rt = await run(machine, {
      subscribe: {} as Subscribe<Msg, RunSub, unknown>,
    }).ready;
    await expect(rt.dispatch({ type: "start", runId: "r1" })).rejects.toThrow(
      /no subscribe runner for Sub type "run"/,
    );
  });

  it("a non-plain `deps` value is refused rather than collapsed onto one id", async () => {
    type ClockState = { readonly startedAt: Date | null };
    type ClockMsg = { readonly type: "restart"; readonly startedAt: Date };
    type ClockSub = Sub<"clock", Date>;
    const clock = defineMachine({
      types: {
        model: {} as ClockState,
        msg: {} as ClockMsg,
        sub: {} as ClockSub,
      },
      init: () => [{ startedAt: null }, []],
      update: { restart: (_s, m) => [{ startedAt: m.startedAt }, []] },
      subs: [{ type: "clock", deps: (s) => s.startedAt }],
    });
    const log: string[] = [];
    const rt = await run(clock, {
      subscribe: {
        clock: () => {
          log.push("start");
          return () => {};
        },
      },
    }).ready;

    await expect(
      rt.dispatch({ type: "restart", startedAt: new Date(1_000) }),
    ).rejects.toThrow(/non-plain object/);
    expect(log).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The built-in `timer` (#270 R1.1) and a user runner replacing it (#270 R2.1).
// ───────────────────────────────────────────────────────────────────────────

type TState = { readonly waiting: boolean; readonly fired: number };
type TMsg = { readonly type: "wait" } | { readonly type: "fire" };

const timed = defineMachine({
  types: { model: {} as TState, msg: {} as TMsg },
  init: () => [{ waiting: false, fired: 0 }, []],
  update: {
    wait: (s) => [{ ...s, waiting: true }, []],
    fire: (s) => [{ waiting: false, fired: s.fired + 1 }, []],
  },
  subs: [
    {
      type: "timer",
      deps: (s) =>
        s.waiting ? { ms: 1_000, msg: { type: "fire" } as const } : null,
    },
  ],
});

describe("the built-in `timer`", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches `msg` after `ms` with no user runner", async () => {
    const rt = await run(timed, {}).ready;
    await rt.dispatch({ type: "wait" });

    await vi.advanceTimersByTimeAsync(999);
    expect(rt.getState().fired).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await rt.idle();
    expect(rt.getState()).toEqual({ waiting: false, fired: 1 });
    await rt.stop();
  });

  it("is cleared when its Sub goes off before it fires", async () => {
    const rt = await run(timed, {}).ready;
    await rt.dispatch({ type: "wait" });
    await rt.stop();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(rt.getState().fired).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a user `subscribe.timer` replaces the built-in", () => {
  // A fake clock the test owns: timers fire only when the test says so.
  function fakeClock() {
    const pending: Array<{ at: number; fire: () => void }> = [];
    let now = 0;
    const timer: Subscribe<TMsg, TimerSub<TMsg>, unknown>["timer"] = (
      sub,
      _ctx,
      dispatch,
    ) => {
      const entry = {
        at: now + sub.deps.ms,
        fire: () => dispatch(sub.deps.msg),
      };
      pending.push(entry);
      return () => {
        pending.splice(pending.indexOf(entry), 1);
      };
    };
    const advance = (ms: number) => {
      now += ms;
      for (const entry of pending.filter((e) => e.at <= now)) {
        pending.splice(pending.indexOf(entry), 1);
        entry.fire();
      }
    };
    return { timer, advance, pending };
  }

  it("drives the machine off the test's clock, and never arms a real timer", async () => {
    vi.useFakeTimers();
    try {
      const clock = fakeClock();
      const rt = await run(timed, { subscribe: { timer: clock.timer } }).ready;
      await rt.dispatch({ type: "wait" });

      expect(vi.getTimerCount()).toBe(0);
      expect(clock.pending).toHaveLength(1);

      clock.advance(999);
      await rt.idle();
      expect(rt.getState().fired).toBe(0);

      clock.advance(1);
      await rt.idle();
      expect(rt.getState()).toEqual({ waiting: false, fired: 1 });
      expect(clock.pending).toHaveLength(0);
      await rt.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("replay — the desired Subs, without running a runner", () => {
  it("reports each on entry as its runner would see it", () => {
    const idle = replay(machine, { msgs: [], ctx: undefined });
    expect(idle.subs).toEqual([]);

    const live = replay(machine, {
      msgs: [{ type: "start", runId: "r1" }],
      ctx: undefined,
    });
    expect(live.subs).toEqual([
      {
        id: subIdOf("run", { runId: "r1" }),
        type: "run",
        deps: { runId: "r1" },
      },
    ]);
  });

  it("reports [] for a machine that declares no `subs`", () => {
    const noSubs = defineMachine({
      types: { model: {} as State, msg: {} as Msg },
      init: () => [idle, []],
      update,
    });
    expect(replay(noSubs, { msgs: [], ctx: undefined }).subs).toEqual([]);
  });
});
