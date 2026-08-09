import { describe, expect, it, vi } from "vitest";
import {
  DispatchDiscardedError,
  defineMachine,
  type Interpret,
  type Reducer,
  RuntimeDiscardedError,
  type RuntimeErrorContext,
  run,
} from "./index";

// ───────────────────────────────────────────────────────────────────────────
// Loud on discard (issue #365). A host that lets go of a runtime while
// `interpret` handlers are still awaiting is dropping their results on the
// floor — `stop()` drains the tail, but every consumer of the resulting
// transitions is being torn down with it. That used to be indistinguishable
// from a clean teardown. It now reports `RuntimeDiscardedError` under
// `phase: "discard"` (TEA invariant 6 — no silent failures).
//
// The phase is a LIFECYCLE report, not a contract failure: tearing a runtime
// down mid-flight is legal, so the default sink WARNS rather than rethrowing —
// a consumer who never configured `onError` gets the signal, not a crash.
// ───────────────────────────────────────────────────────────────────────────

type State = { readonly started: number; readonly done: number };
type Msg = { readonly type: "go" } | { readonly type: "arrived" };
type FetchCmd = { readonly type: "fetch" };

// A machine whose one Cmd parks on a caller-controlled promise, so a test can
// hold a Cmd "in flight" across a `stop()` and release it afterwards. Its
// handler ALWAYS returns the terminal Msg — releasing the park after `stop()`
// therefore re-dispatches into a runtime that is tearing down, which is the
// teardown-discard path (`DispatchDiscardedError`), not a follow-up failure.
function parkingMachine(park: Promise<void>) {
  const update: Reducer<State, Msg, FetchCmd> = {
    go: (s) => [{ ...s, started: s.started + 1 }, [{ type: "fetch" }]],
    arrived: (s) => [{ ...s, done: s.done + 1 }, []],
  };
  const interpret: Interpret<Msg, FetchCmd, undefined> = {
    fetch: async () => {
      await park;
      return { type: "arrived" as const };
    },
  };
  return defineMachine<State, Msg, FetchCmd, never, undefined>({
    init: () => [{ started: 0, done: 0 }, []],
    update,
    interpret,
  });
}

// Let every already-queued microtask run — the report of a refused re-dispatch
// happens in a `.catch`, one tick after the rejection it observes.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

// Capture the macrotasks the default sink schedules instead of letting them
// become process-level uncaught exceptions — the same interception
// `run-errors.test.ts` uses to assert the "surface, never swallow" default.
// `scheduled` being EMPTY is the proof that nothing was rethrown.
function captureRethrows(): {
  scheduled: Array<() => void>;
  restore: () => void;
} {
  const scheduled: Array<() => void> = [];
  const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: () => void,
  ) => {
    scheduled.push(fn);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  return {
    scheduled,
    restore: () => {
      spy.mockRestore();
    },
  };
}

describe("stop() with Cmds in flight reports phase: discard", () => {
  it("reports RuntimeDiscardedError carrying the in-flight count", async () => {
    const seen: { error: unknown; context: RuntimeErrorContext }[] = [];
    let release = (): void => {};
    const park = new Promise<void>((resolve) => {
      release = () => {
        resolve();
      };
    });
    const runtime = await run(parkingMachine(park), {
      ctx: undefined,
      onError: (error, context) => {
        seen.push({ error, context });
      },
    }).ready;

    // `dispatchOnce` would still await the transition (and thus the parked
    // Cmd). Fire and forget so the Cmd is genuinely outstanding at stop time.
    void runtime.dispatch({ type: "go" });
    // Let the tail advance into the interpret handler's `await park`.
    await Promise.resolve();
    await Promise.resolve();

    const stopping = runtime.stop();
    // Reported BEFORE the drain — the fact worth surfacing is what was
    // outstanding at the moment the host let go.
    const discards = seen.filter((s) => s.context.phase === "discard");
    expect(discards).toHaveLength(1);
    const error = discards[0]?.error;
    expect(error).toBeInstanceOf(RuntimeDiscardedError);
    expect((error as RuntimeDiscardedError).pendingCmds).toBe(1);

    release();
    await stopping;
  });

  it("stays silent when the runtime is quiescent at stop time", async () => {
    const seen: RuntimeErrorContext[] = [];
    const park = Promise.resolve();
    const runtime = await run(parkingMachine(park), {
      ctx: undefined,
      onError: (_error, context) => {
        seen.push(context);
      },
    }).ready;

    // Run to quiescence: the Cmd resolves and its follow-up folds back in.
    await runtime.dispatch({ type: "go" });
    expect(runtime.getState()).toEqual({ started: 1, done: 1 });

    await runtime.stop();
    expect(seen).toEqual([]);
  });

  it("warns (never throws) through the default sink", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rethrows = captureRethrows();
    let release = (): void => {};
    const park = new Promise<void>((resolve) => {
      release = () => {
        resolve();
      };
    });
    // No `onError` — this is the consumer who never configured a sink. The
    // default sink rethrows every OTHER error on a fresh macrotask; a teardown
    // notice must not become an uncaught error just because a host unmounted
    // during a fetch. The parked Cmd DOES return a follow-up Msg here: the whole
    // mid-flight teardown, end to end, must stay warn-only.
    const runtime = await run(parkingMachine(park), { ctx: undefined }).ready;

    void runtime.dispatch({ type: "go" });
    await Promise.resolve();
    await Promise.resolve();

    const stopping = runtime.stop();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBeInstanceOf(RuntimeDiscardedError);

    release();
    await stopping;
    await flushMicrotasks();
    // The released Cmd's follow-up arrived during the drain and was refused —
    // reported, warned, never rethrown.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[0]).toBeInstanceOf(DispatchDiscardedError);
    // Nothing was scheduled for a macrotask rethrow: an unmount during a fetch
    // is not an uncaught error for a consumer who configured nothing.
    expect(rethrows.scheduled).toEqual([]);
    rethrows.restore();
    warn.mockRestore();
  });

  it("does not strand the count when an in-flight handler rejects", async () => {
    const seen: RuntimeErrorContext[] = [];
    const boom = defineMachine<State, Msg, FetchCmd, never, undefined>({
      init: () => [{ started: 0, done: 0 }, []],
      update: {
        go: (s) => [{ ...s, started: s.started + 1 }, [{ type: "fetch" }]],
        arrived: (s) => [{ ...s, done: s.done + 1 }, []],
      } satisfies Reducer<State, Msg, FetchCmd>,
      interpret: {
        fetch: async () => {
          throw new Error("cmd failed");
        },
      } satisfies Interpret<Msg, FetchCmd, undefined>,
    });
    const runtime = await run(boom, {
      ctx: undefined,
      onError: (_error, context) => {
        seen.push(context);
      },
    }).ready;

    await expect(runtime.dispatch({ type: "go" })).rejects.toThrow(
      "cmd failed",
    );
    await runtime.stop();
    // The rejection is the caller's (it surfaced at `dispatch`); a rejected
    // handler is NOT in flight afterwards, so the teardown is clean.
    expect(seen.filter((c) => c.phase === "discard")).toEqual([]);
  });
});

describe("a throwing consumer sink is never swallowed by the discard branch", () => {
  // `reportError` hands a throwing sink's OWN error onward with the context it
  // was handling — so a warn branch keyed on `phase: "discard"` would have made
  // a broken sink vanish, re-creating the silent failure this file exists to
  // remove. Fatality is decided by the ERROR CLASS: only the runtime's own
  // `RuntimeDiscardNotice`s warn.
  it("rethrows the sink's error on a macrotask while handling a discard", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rethrows = captureRethrows();
    const SINK_BOOM = new Error("sink boom while reporting the discard");
    let release = (): void => {};
    const park = new Promise<void>((resolve) => {
      release = () => {
        resolve();
      };
    });

    const runtime = await run(parkingMachine(park), {
      ctx: undefined,
      onError: (_error, context) => {
        if (context.phase === "discard") throw SINK_BOOM;
      },
    }).ready;

    void runtime.dispatch({ type: "go" });
    await Promise.resolve();
    await Promise.resolve();

    const stopping = runtime.stop();
    release();
    await stopping;
    await flushMicrotasks();

    // The sink's defect surfaces to the host, exactly as it does for every
    // other phase — it is NOT a lossy-but-legal teardown fact.
    expect(rethrows.scheduled.length).toBeGreaterThanOrEqual(1);
    expect(() => {
      for (const fn of rethrows.scheduled) fn();
    }).toThrow(SINK_BOOM);
    // And it was never demoted to a warning.
    expect(warn).not.toHaveBeenCalled();
    rethrows.restore();
    warn.mockRestore();
  });
});

describe("the stop barrier distinguishes the drain window from after it", () => {
  type Msg2 = { readonly type: "go" } | { readonly type: "late" };
  type SlowCmd = { readonly type: "slow" };

  // Captures the injected detached dispatch so a test can fire a Msg at a
  // chosen moment — the shape a `ctx.waitUntil` tail has in production.
  function detachedMachine(
    onDispatch: (dispatch: (msg: Msg2) => void) => void,
  ) {
    const update: Reducer<State, Msg2, SlowCmd> = {
      go: (s) => [{ ...s, started: s.started + 1 }, [{ type: "slow" }]],
      late: (s) => [{ ...s, done: s.done + 1 }, []],
    };
    const interpret: Interpret<Msg2, SlowCmd, undefined> = {
      slow: async (_cmd, _ctx, dispatch) => {
        onDispatch(dispatch);
      },
    };
    return defineMachine<State, Msg2, SlowCmd, never, undefined>({
      init: () => [{ started: 0, done: 0 }, []],
      update,
      interpret,
    });
  }

  it("reports a Msg refused AFTER stop() returned as an error, not a discard", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rethrows = captureRethrows();
    const seen: { error: unknown; context: RuntimeErrorContext }[] = [];
    let dispatchLate: ((msg: Msg2) => void) | undefined;

    const runtime = await run(
      detachedMachine((dispatch) => {
        dispatchLate = dispatch;
      }),
      {
        ctx: undefined,
        onError: (error, context) => {
          seen.push({ error, context });
        },
      },
    ).ready;

    await runtime.dispatch({ type: "go" });
    // Fully torn down: nothing is in flight, so no discard is reported.
    await runtime.stop();
    expect(seen).toEqual([]);

    // A dispatch from outside the drain window is a consumer using a runtime it
    // already retired. Loud — never re-labelled a teardown discard.
    dispatchLate?.({ type: "late" });
    await flushMicrotasks();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.context.phase).toBe("follow-up");
    expect(seen[0]?.error).not.toBeInstanceOf(DispatchDiscardedError);
    expect(seen[0]?.error).toBeInstanceOf(Error);
    expect((seen[0]?.error as Error).message).toContain("runtime stopped");
    // The caller sees the same refusal.
    await expect(runtime.dispatch({ type: "late" })).rejects.toThrow(
      "runtime stopped",
    );
    expect(warn).not.toHaveBeenCalled();
    rethrows.restore();
    warn.mockRestore();
  });

  it("a configured sink sees a drain-window refusal under phase: discard", async () => {
    const seen: { error: unknown; context: RuntimeErrorContext }[] = [];
    let dispatchDuringDrain: ((msg: Msg2) => void) | undefined;

    const runtime = await run(
      detachedMachine((dispatch) => {
        dispatchDuringDrain = dispatch;
      }),
      {
        ctx: undefined,
        onError: (error, context) => {
          seen.push({ error, context });
        },
      },
    ).ready;

    await runtime.dispatch({ type: "go" });
    const stopping = runtime.stop();
    dispatchDuringDrain?.({ type: "late" });
    await stopping;
    await flushMicrotasks();

    // The phase is DERIVED from the rejection the gate produced — a sink that
    // routes by phase sees the teardown, not a follow-up failure.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.context.phase).toBe("discard");
    expect(seen[0]?.error).toBeInstanceOf(DispatchDiscardedError);
  });

  it("a Msg refused DURING the drain is a discard the default sink warns about", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rethrows = captureRethrows();
    let dispatchDuringDrain: ((msg: Msg2) => void) | undefined;

    // No sink — the consumer who configured nothing must not get an uncaught
    // error out of a teardown that raced an in-flight handler.
    const runtime = await run(
      detachedMachine((dispatch) => {
        dispatchDuringDrain = dispatch;
      }),
      { ctx: undefined },
    ).ready;

    await runtime.dispatch({ type: "go" });
    const stopping = runtime.stop();
    // Inside the drain window: `stop()` has raised the barrier but has not
    // returned. This is the teardown discarding its own in-flight work.
    dispatchDuringDrain?.({ type: "late" });
    await stopping;
    await flushMicrotasks();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBeInstanceOf(DispatchDiscardedError);
    expect((warn.mock.calls[0]?.[0] as DispatchDiscardedError).msgType).toBe(
      "late",
    );
    expect(rethrows.scheduled).toEqual([]);
    // The Msg was REFUSED, not folded — the stop barrier is absolute.
    expect(runtime.getState()).toEqual({ started: 1, done: 0 });
    rethrows.restore();
    warn.mockRestore();
  });
});
