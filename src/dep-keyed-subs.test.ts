import { describe, expect, it, vi } from "vitest";
import {
  type DepKeyedSub,
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
// gate (`deps === null` ⇒ inactive). What the tests here pin is the reconcile
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
