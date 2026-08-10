import { describe, expect, it, vi } from "vitest";
import {
  type DepKeyedSub,
  DispatchDiscardedError,
  defineMachine,
  type Interpret,
  type Reducer,
  replay,
  run,
  type Sub,
  subId,
} from "./index";

// ───────────────────────────────────────────────────────────────────────────
// Dep-keyed Subs: the author declares the state slice a Sub depends on, and
// the kernel derives BOTH the id (`structuralHash(deps)`) and the active-set
// gate (a nullish `deps` ⇒ inactive). What the tests here pin is the reconcile
// contract — arm / no-churn / re-arm / teardown — plus the additivity claim:
// a machine with no `subs` field behaves exactly as before, and a machine that
// uses BOTH `subs` and the manual `subscriptions` escape hatch runs both
// through ONE reconcile pass.
// ───────────────────────────────────────────────────────────────────────────

type State = { readonly runId: string | null; readonly phase: "idle" | "live" };
type Msg =
  | { readonly type: "start"; readonly runId: string }
  | { readonly type: "rekey"; readonly runId: string }
  | { readonly type: "stop" }
  | { readonly type: "noop" };

const update: Reducer<State, Msg, never> = {
  start: (_s, m) => [{ runId: m.runId, phase: "live" }, []],
  rekey: (s, m) => [{ ...s, runId: m.runId }, []],
  stop: () => [{ runId: null, phase: "idle" }, []],
  noop: (s) => [s, []],
};

// A recording dep-keyed entry: `deps` is the run identity while live, `null`
// while idle. Every arm and every dispose is logged so the reconcile decisions
// are observable rather than inferred.
function recordingEntry(log: string[]): DepKeyedSub<State, Msg, undefined> {
  return {
    deps: (s) => (s.phase === "live" ? { runId: s.runId } : null),
    source: (s) => {
      log.push(`arm:${s.runId}`);
      return () => log.push(`dispose:${s.runId}`);
    },
  };
}

function machineWith(
  subs: ReadonlyArray<DepKeyedSub<State, Msg, undefined>>,
): ReturnType<typeof defineMachine<State, Msg, never, never, undefined>> {
  return defineMachine<State, Msg, never, never, undefined>({
    init: () => [{ runId: null, phase: "idle" }, []],
    update,
    subs,
    interpret: {} as Interpret<Msg, never, undefined>,
  });
}

describe("dep-keyed Subs — the reconcile contract", () => {
  it("arms when `deps` goes non-null and tears down when it goes null", async () => {
    const log: string[] = [];
    const rt = await run(machineWith([recordingEntry(log)]), { ctx: undefined })
      .ready;

    // Boot in `idle` → deps null → nothing armed.
    expect(log).toEqual([]);

    await rt.dispatch({ type: "start", runId: "r1" });
    expect(log).toEqual(["arm:r1"]);

    await rt.dispatch({ type: "stop" });
    expect(log).toEqual(["arm:r1", "dispose:r1"]);
  });

  it("does NOT churn while `deps` is unchanged (the #1 Sub bug)", async () => {
    const log: string[] = [];
    const rt = await run(machineWith([recordingEntry(log)]), { ctx: undefined })
      .ready;

    await rt.dispatch({ type: "start", runId: "r1" });
    // Three transitions that leave the slice identical. A hand-written subId
    // rebuilt per transition would remount here; a derived id must not.
    await rt.dispatch({ type: "noop" });
    await rt.dispatch({ type: "noop" });
    await rt.dispatch({ type: "rekey", runId: "r1" });

    expect(log).toEqual(["arm:r1"]);
  });

  it("re-arms on a `deps` change: old dispose FIRST, then the fresh source", async () => {
    const log: string[] = [];
    const rt = await run(machineWith([recordingEntry(log)]), { ctx: undefined })
      .ready;

    await rt.dispatch({ type: "start", runId: "r1" });
    await rt.dispatch({ type: "rekey", runId: "r2" });

    // Ordering is the contract: never two live sources for one slot.
    expect(log).toEqual(["arm:r1", "dispose:r1", "arm:r2"]);
  });

  it("disposes every live source on stop()", async () => {
    const log: string[] = [];
    const rt = await run(machineWith([recordingEntry(log)]), { ctx: undefined })
      .ready;

    await rt.dispatch({ type: "start", runId: "r1" });
    await rt.stop();
    expect(log).toEqual(["arm:r1", "dispose:r1"]);

    // Idempotent — the slot is gone, so a second stop disposes nothing twice.
    await rt.stop();
    expect(log).toEqual(["arm:r1", "dispose:r1"]);
  });

  it("keys each entry by its own array slot, so sibling entries are independent", async () => {
    const log: string[] = [];
    const alwaysOn: DepKeyedSub<State, Msg, undefined> = {
      deps: () => ({ kind: "always" }),
      source: () => {
        log.push("arm:always");
        return () => log.push("dispose:always");
      },
    };
    const rt = await run(machineWith([recordingEntry(log), alwaysOn]), {
      ctx: undefined,
    }).ready;

    // The always-on entry arms at boot even though its sibling's deps are null.
    expect(log).toEqual(["arm:always"]);

    await rt.dispatch({ type: "start", runId: "r1" });
    await rt.dispatch({ type: "rekey", runId: "r2" });

    // Only the keyed sibling churned; the always-on slot stayed put.
    expect(log).toEqual(["arm:always", "arm:r1", "dispose:r1", "arm:r2"]);
  });

  it("a source throw is isolated: siblings still arm, and the throw surfaces", async () => {
    const log: string[] = [];
    const boom: DepKeyedSub<State, Msg, undefined> = {
      deps: (s) => (s.phase === "live" ? { runId: s.runId } : null),
      source: () => {
        throw new Error("source failed");
      },
    };
    const rt = await run(machineWith([boom, recordingEntry(log)]), {
      ctx: undefined,
    }).ready;

    await expect(rt.dispatch({ type: "start", runId: "r1" })).rejects.toThrow(
      "source failed",
    );
    // The failing entry did NOT strand its sibling.
    expect(log).toEqual(["arm:r1"]);
  });

  it("a dispose throw is routed to onError, not swallowed, and the slot still clears", async () => {
    const log: string[] = [];
    const onError = vi.fn();
    const badCleanup: DepKeyedSub<State, Msg, undefined> = {
      deps: (s) => (s.phase === "live" ? { runId: s.runId } : null),
      source: (s) => {
        log.push(`arm:${s.runId}`);
        return () => {
          throw new Error("dispose failed");
        };
      },
    };
    const rt = await run(machineWith([badCleanup]), {
      ctx: undefined,
      onError,
    }).ready;

    await rt.dispatch({ type: "start", runId: "r1" });
    await rt.dispatch({ type: "rekey", runId: "r2" });

    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      phase: "sub-cleanup",
    });
    // The re-arm still happened despite the failing dispose.
    expect(log).toEqual(["arm:r1", "arm:r2"]);
  });

  it("dispatches through the same serial tail every other Msg goes through", async () => {
    // A source that fires a Msg back into the machine — the seam that makes a
    // dep-keyed Sub a real Sub and not just a lifecycle hook.
    const entry: DepKeyedSub<State, Msg, undefined> = {
      deps: (s) => (s.phase === "live" ? { runId: s.runId } : null),
      source: (s, dispatch) => {
        if (s.runId === "r1") dispatch({ type: "rekey", runId: "r2" });
        return () => {};
      },
    };
    const rt = await run(machineWith([entry]), { ctx: undefined }).ready;

    await rt.dispatch({ type: "start", runId: "r1" });
    await rt.idle();
    expect(rt.getState().runId).toBe("r2");
  });
});

describe("dep-keyed Subs — additivity", () => {
  it("a machine with no `subs` field reconciles exactly as before", async () => {
    const noSubs = defineMachine<State, Msg, never, never, undefined>({
      init: () => [{ runId: null, phase: "idle" }, []],
      update,
      interpret: {} as Interpret<Msg, never, undefined>,
    });
    const rt = await run(noSubs, { ctx: undefined }).ready;
    await rt.dispatch({ type: "start", runId: "r1" });
    expect(rt.getState()).toEqual({ runId: "r1", phase: "live" });
    await rt.stop();
  });

  it("`subs` and the manual `subscriptions` escape hatch feed ONE reconcile pass", async () => {
    const log: string[] = [];
    type ManualSub = Sub<"manual">;
    const both = defineMachine<State, Msg, never, ManualSub, undefined>({
      init: () => [{ runId: null, phase: "idle" }, []],
      update,
      subs: [recordingEntry(log)],
      subscriptions: (s) =>
        s.phase === "live" ? [{ id: subId("manual"), type: "manual" }] : [],
      subscribe: {
        manual: () => {
          log.push("arm:manual");
          return () => log.push("dispose:manual");
        },
      },
      interpret: {} as Interpret<Msg, never, undefined>,
    });

    const rt = await run(both, { ctx: undefined }).ready;
    await rt.dispatch({ type: "start", runId: "r1" });
    // Dep-keyed pass runs first, then the manual aggregate.
    expect(log).toEqual(["arm:r1", "arm:manual"]);

    await rt.dispatch({ type: "stop" });
    expect(log).toEqual([
      "arm:r1",
      "arm:manual",
      "dispose:r1",
      "dispose:manual",
    ]);
  });

  it("surfaces a dep-keyed source throw even when a manual aggregate also runs", async () => {
    // The dep-keyed pass runs FIRST; its error must survive the manual pass
    // rather than being overwritten by the manual pass's own (absent) error.
    const log: string[] = [];
    type ManualSub = Sub<"manual">;
    const both = defineMachine<State, Msg, never, ManualSub, undefined>({
      init: () => [{ runId: null, phase: "idle" }, []],
      update,
      subs: [
        {
          deps: (s) => (s.phase === "live" ? { runId: s.runId } : null),
          source: () => {
            throw new Error("source failed");
          },
        },
      ],
      subscriptions: (s) =>
        s.phase === "live" ? [{ id: subId("manual"), type: "manual" }] : [],
      subscribe: {
        manual: () => {
          log.push("arm:manual");
          return () => log.push("dispose:manual");
        },
      },
      interpret: {} as Interpret<Msg, never, undefined>,
    });

    const rt = await run(both, { ctx: undefined }).ready;
    await expect(rt.dispatch({ type: "start", runId: "r1" })).rejects.toThrow(
      "source failed",
    );
    // …and the manual sub still armed despite the dep-keyed failure.
    expect(log).toEqual(["arm:manual"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The gate is "no slice", not "the literal null". `(s) => s.runId` over an
// OPTIONAL field yields `undefined`, which used to sail past `deps === null`
// and arm the Sub under the id `"undefined"` — a resource acquired for a state
// that meant "inactive", and one shared key for every such state.
// ───────────────────────────────────────────────────────────────────────────
describe("dep-keyed Subs — `undefined` deps mean inactive, exactly like null", () => {
  type OptState = { readonly runId?: string };
  type OptMsg =
    | { readonly type: "start"; readonly runId: string }
    | { readonly type: "clear" };

  function optMachine(
    entry: DepKeyedSub<OptState, OptMsg, undefined>,
  ): ReturnType<
    typeof defineMachine<OptState, OptMsg, never, never, undefined>
  > {
    return defineMachine<OptState, OptMsg, never, never, undefined>({
      init: () => [{}, []],
      update: {
        start: (_s, m) => [{ runId: m.runId }, []],
        clear: () => [{}, []],
      },
      subs: [entry],
      interpret: {} as Interpret<OptMsg, never, undefined>,
    });
  }

  const optEntry = (
    log: string[],
  ): DepKeyedSub<OptState, OptMsg, undefined> => ({
    // The natural projection over an optional field: `undefined` when absent.
    deps: (s) => s.runId,
    source: (s) => {
      log.push(`arm:${s.runId}`);
      return () => log.push(`dispose:${s.runId}`);
    },
  });

  it("does not arm when `deps` returns undefined", async () => {
    const log: string[] = [];
    const rt = await run(optMachine(optEntry(log)), { ctx: undefined }).ready;
    expect(log).toEqual([]);
    await rt.stop();
  });

  it("arms on a real slice and tears down when the field goes away again", async () => {
    const log: string[] = [];
    const rt = await run(optMachine(optEntry(log)), { ctx: undefined }).ready;

    await rt.dispatch({ type: "start", runId: "r1" });
    expect(log).toEqual(["arm:r1"]);

    await rt.dispatch({ type: "clear" });
    expect(log).toEqual(["arm:r1", "dispose:r1"]);
  });

  it("`replay` projects the same gate — no entry for an undefined slice", () => {
    const idle = replay(optMachine(optEntry([])), { msgs: [], ctx: undefined });
    expect(idle.depSubs).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F7: `deps` is user code on the same footing as `source`. The reconcile pass
// isolated a throwing `source` but not a throwing `deps`, so one bad projection
// stranded every LATER dep-keyed entry — and the manual `subscriptions`
// aggregate, which is reached only after the loop.
// ───────────────────────────────────────────────────────────────────────────
describe("dep-keyed Subs — a throwing `deps` is isolated like a throwing `source`", () => {
  // Throws only once the machine is live, so boot succeeds and the failure
  // lands on a reconcile the test drives — the shape a real projection has
  // (`s.runId.slice(...)` on a phase where `runId` is absent).
  const boomDeps: DepKeyedSub<State, Msg, undefined> = {
    deps: (s) => {
      if (s.phase === "live") throw new Error("deps failed");
      return null;
    },
    source: () => () => {},
  };

  it("does not strand the entries that come after it", async () => {
    const log: string[] = [];
    const rt = await run(machineWith([boomDeps, recordingEntry(log)]), {
      ctx: undefined,
    }).ready;

    await expect(rt.dispatch({ type: "start", runId: "r1" })).rejects.toThrow(
      "deps failed",
    );
    expect(log).toEqual(["arm:r1"]);
  });

  it("does not strand the manual `subscriptions` aggregate after the loop", async () => {
    const log: string[] = [];
    type ManualSub = Sub<"manual">;
    const both = defineMachine<State, Msg, never, ManualSub, undefined>({
      init: () => [{ runId: null, phase: "idle" }, []],
      update,
      subs: [boomDeps],
      subscriptions: (s) =>
        s.phase === "live" ? [{ id: subId("manual"), type: "manual" }] : [],
      subscribe: {
        manual: () => {
          log.push("arm:manual");
          return () => log.push("dispose:manual");
        },
      },
      interpret: {} as Interpret<Msg, never, undefined>,
    });

    const rt = await run(both, { ctx: undefined }).ready;
    await expect(rt.dispatch({ type: "start", runId: "r1" })).rejects.toThrow(
      "deps failed",
    );
    expect(log).toEqual(["arm:manual"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F1b: a non-plain deps slice (the everyday `Date` in a state slice) hashed to
// `"{}"` for every value, so the id never changed: the Sub stayed armed on the
// FIRST slice forever and presented as the no-churn success case. The hash now
// refuses it, and the refusal surfaces through the same path a source throw
// does.
// ───────────────────────────────────────────────────────────────────────────
describe("dep-keyed Subs — a non-plain deps slice fails loudly, never silently sticks", () => {
  type ClockState = { readonly startedAt: Date | null };
  type ClockMsg = { readonly type: "restart"; readonly startedAt: Date };

  it("refuses to key a Sub on a Date instead of collapsing every slice into one id", async () => {
    const log: string[] = [];
    const clock = defineMachine<ClockState, ClockMsg, never, never, undefined>({
      init: () => [{ startedAt: null }, []],
      update: { restart: (_s, m) => [{ startedAt: m.startedAt }, []] },
      subs: [
        {
          deps: (s) => s.startedAt,
          source: (s) => {
            log.push(`arm:${s.startedAt?.getTime()}`);
            return () => log.push("dispose");
          },
        },
      ],
      interpret: {} as Interpret<ClockMsg, never, undefined>,
    });

    const rt = await run(clock, { ctx: undefined }).ready;
    await expect(
      rt.dispatch({ type: "restart", startedAt: new Date(1_000) }),
    ).rejects.toThrow(/non-plain object/);
    expect(log).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F2: a dep-keyed source got the RAW `enqueueDispatch`, whose promise rejects
// when the gate is shut. A source that dispatches during teardown therefore
// produced an unhandled rejection that bypassed `onError` entirely — the sink
// saw nothing and the host saw an `unhandledRejection`. Sources dispatch
// through the same `(msg) => void` wrapper interpret handlers use, so the
// rejection lands on the sink with the phase DERIVED from the error class.
// ───────────────────────────────────────────────────────────────────────────
describe("dep-keyed Subs — a dispatch during teardown reaches the sink, not the host", () => {
  it("reports a source's teardown-window dispatch as a discard", async () => {
    const reports: Array<{ error: unknown; phase: string }> = [];
    let fire: (() => void) | undefined;
    const entry: DepKeyedSub<State, Msg, undefined> = {
      deps: (s) => (s.phase === "live" ? { runId: s.runId } : null),
      source: (_s, dispatch) => {
        fire = () => dispatch({ type: "noop" });
        return () => {};
      },
    };
    const rt = await run(machineWith([entry]), {
      ctx: undefined,
      onError: (error, context) =>
        reports.push({ error, phase: context.phase }),
    }).ready;
    await rt.dispatch({ type: "start", runId: "r1" });

    // The window `stop()` opens: the gate refuses new work while the tail
    // drains, and a still-live Sub can fire into it.
    const stopping = rt.stop();
    fire?.();
    await stopping;

    expect(reports).toHaveLength(1);
    expect(reports[0]?.phase).toBe("discard");
    expect(reports[0]?.error).toBeInstanceOf(DispatchDiscardedError);
  });

  it("reports a manual subscribe handler's teardown-window dispatch too", async () => {
    const reports: Array<{ error: unknown; phase: string }> = [];
    let fire: (() => void) | undefined;
    type ManualSub = Sub<"manual">;
    const manual = defineMachine<State, Msg, never, ManualSub, undefined>({
      init: () => [{ runId: null, phase: "idle" }, []],
      update,
      subscriptions: (s) =>
        s.phase === "live" ? [{ id: subId("manual"), type: "manual" }] : [],
      subscribe: {
        manual: (_sub, _ctx, dispatch) => {
          fire = () => dispatch({ type: "noop" });
          return () => {};
        },
      },
      interpret: {} as Interpret<Msg, never, undefined>,
    });
    const rt = await run(manual, {
      ctx: undefined,
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

describe("replay — the dep-keyed desired set, without wiring anything", () => {
  it("reports the active entries' index + derived id, and never calls `source`", () => {
    let sourceCalls = 0;
    const entry: DepKeyedSub<State, Msg, undefined> = {
      deps: (s) => (s.phase === "live" ? { runId: s.runId } : null),
      source: () => {
        sourceCalls += 1;
        return () => {};
      },
    };

    const idle = replay(machineWith([entry]), { msgs: [], ctx: undefined });
    expect(idle.depSubs).toEqual([]);

    const live = replay(machineWith([entry]), {
      msgs: [{ type: "start", runId: "r1" }],
      ctx: undefined,
    });
    expect(live.depSubs).toEqual([{ index: 0, id: '{"runId":"r1"}' }]);
    expect(sourceCalls).toBe(0);
  });

  it("reports [] for a machine that declares no `subs`", () => {
    const noSubs = defineMachine<State, Msg, never, never, undefined>({
      init: () => [{ runId: null, phase: "idle" }, []],
      update,
      interpret: {} as Interpret<Msg, never, undefined>,
    });
    expect(replay(noSubs, { msgs: [], ctx: undefined }).depSubs).toEqual([]);
  });
});
