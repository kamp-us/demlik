import { describe, expect, it, vi } from "vitest";
import {
  type Cmd,
  defineMachine,
  type Reducer,
  type RuntimeErrorContext,
  run,
  type Store,
  type Supervision,
} from "./index";

// ───────────────────────────────────────────────────────────────────────────
// Supervision — declared policy for a reducer (`update`) throw (ADR 0003 #4).
//
// The resilience kit covers *effect* failures; before this primitive a throw
// inside the pure reducer had NO declared policy — it merely rejected the
// dispatch promise. Now the throw is caught in the dispatch loop, surfaced via
// the #51 `onError` sink with `phase: "reduce"` (invariant 6 — errors are
// data), and routed to the configured strategy:
//   - `stop`     (default) — surface + halt; subsequent dispatches reject.
//   - `escalate`           — surface + propagate; runtime stays live.
//   - `restart`            — surface, re-init from host last-good, keep folding.
//
// #71's reentrancy brand is what makes this catchable: the reducer is provably
// synchronous, so its throw is a synchronous throw with state at its
// pre-transition value.
// ───────────────────────────────────────────────────────────────────────────

type State = { readonly n: number };
type Msg = { readonly type: "inc" } | { readonly type: "boom" };

const REDUCE_BOOM = new Error("reducer invariant violated");

// A counter whose `boom` cell deliberately throws. `inc` is a normal pure
// transition — the same machine proves a non-throwing reducer is unaffected.
function throwingMachine() {
  const update: Reducer<State, Msg, Cmd> = {
    inc: (s) => [{ n: s.n + 1 }, []],
    boom: () => {
      throw REDUCE_BOOM;
    },
  };
  return defineMachine<State, Msg, Cmd, never, undefined>({
    init: (loaded) => [(loaded as State | null) ?? { n: 0 }, []],
    update,
  });
}

function collectErrors() {
  const seen: { error: unknown; context: RuntimeErrorContext }[] = [];
  return {
    seen,
    onError: (error: unknown, context: RuntimeErrorContext) =>
      seen.push({ error, context }),
  };
}

describe("supervision: stop (the safe default)", () => {
  it("default (no supervision) surfaces the reduce throw and halts the runtime", async () => {
    const { seen, onError } = collectErrors();
    const runtime = await run(throwingMachine(), { ctx: undefined, onError })
      .ready;

    // The throwing dispatch rejects with the reducer error — the halt is
    // observable, never a silent resume.
    await expect(runtime.dispatch({ type: "boom" })).rejects.toBe(REDUCE_BOOM);

    // Surfaced as data via onError with phase "reduce".
    expect(seen).toHaveLength(1);
    expect(seen[0]?.error).toBe(REDUCE_BOOM);
    expect(seen[0]?.context.phase).toBe("reduce");

    // State did NOT advance (the reducer never produced a result).
    expect(runtime.getState()).toEqual({ n: 0 });

    // The runtime is halted: every subsequent dispatch rejects.
    await expect(runtime.dispatch({ type: "inc" })).rejects.toThrow(
      "runtime stopped",
    );

    await runtime.stop();
  });

  it("explicit { strategy: 'stop' } behaves identically to the default", async () => {
    const { seen, onError } = collectErrors();
    const supervision: Supervision<State, Msg> = { strategy: "stop" };
    const runtime = await run(throwingMachine(), {
      ctx: undefined,
      onError,
      supervision,
    }).ready;

    await expect(runtime.dispatch({ type: "boom" })).rejects.toBe(REDUCE_BOOM);
    expect(seen[0]?.context.phase).toBe("reduce");
    await expect(runtime.dispatch({ type: "inc" })).rejects.toThrow(
      "runtime stopped",
    );
    await runtime.stop();
  });
});

describe("supervision: escalate (surface + propagate, runtime stays live)", () => {
  it("surfaces via onError, rejects the dispatch, but does NOT halt the runtime", async () => {
    const { seen, onError } = collectErrors();
    const runtime = await run(throwingMachine(), {
      ctx: undefined,
      onError,
      supervision: "escalate",
    }).ready;

    // First advance state so we can prove the runtime keeps folding afterward.
    await runtime.dispatch({ type: "inc" });
    expect(runtime.getState()).toEqual({ n: 1 });

    // The throwing dispatch surfaces + propagates.
    await expect(runtime.dispatch({ type: "boom" })).rejects.toBe(REDUCE_BOOM);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.context.phase).toBe("reduce");

    // Runtime is NOT halted — a subsequent dispatch still folds.
    await runtime.dispatch({ type: "inc" });
    expect(runtime.getState()).toEqual({ n: 2 });

    await runtime.stop();
  });
});

describe("supervision: restart (re-init from host last-known-good, keep folding)", () => {
  it("rehydrates from the host-supplied state, surfaces the failure, and continues", async () => {
    const { seen, onError } = collectErrors();
    const lastGood: State = { n: 42 };
    const rehydrate = vi.fn(
      (_state: State, _msg: Msg, _error: unknown): State => lastGood,
    );

    const runtime = await run(throwingMachine(), {
      ctx: undefined,
      onError,
      supervision: { strategy: "restart", rehydrate },
    }).ready;

    // The throwing dispatch RESOLVES — restart recovered.
    await expect(runtime.dispatch({ type: "boom" })).resolves.toBeUndefined();

    // The failure was still surfaced as data via onError (phase "reduce").
    expect(seen).toHaveLength(1);
    expect(seen[0]?.error).toBe(REDUCE_BOOM);
    expect(seen[0]?.context.phase).toBe("reduce");

    // The host rehydrate was invoked with the failing (state, msg, error) ...
    expect(rehydrate).toHaveBeenCalledTimes(1);
    expect(rehydrate).toHaveBeenCalledWith(
      { n: 0 },
      { type: "boom" },
      REDUCE_BOOM,
    );

    // ... and its return value is now the live state.
    expect(runtime.getState()).toEqual(lastGood);

    // The runtime keeps folding from the rehydrated state.
    await runtime.dispatch({ type: "inc" });
    expect(runtime.getState()).toEqual({ n: 43 });

    await runtime.stop();
  });

  it("persists the rehydrated state via the store before continuing", async () => {
    const { onError } = collectErrors();
    const saved: State[] = [];
    const store: Store<State> = {
      async load() {
        return null;
      },
      migrate: (raw) => (raw as State | null) ?? null,
      async save(s) {
        saved.push(s);
      },
    };
    const lastGood: State = { n: 7 };
    const runtime = await run(throwingMachine(), {
      ctx: undefined,
      store,
      onError,
      supervision: { strategy: "restart", rehydrate: () => lastGood },
    }).ready;
    saved.length = 0; // drop the boot save

    await runtime.dispatch({ type: "boom" });
    // The rehydrated last-good state was persisted.
    expect(saved).toContainEqual(lastGood);

    await runtime.stop();
  });

  it("a throw inside rehydrate itself propagates (recovery source is broken)", async () => {
    const { seen, onError } = collectErrors();
    const REHYDRATE_FAIL = new Error("snapshot source unreachable");
    const runtime = await run(throwingMachine(), {
      ctx: undefined,
      onError,
      supervision: {
        strategy: "restart",
        rehydrate: () => {
          throw REHYDRATE_FAIL;
        },
      },
    }).ready;

    // The original reduce failure is still surfaced as data ...
    await expect(runtime.dispatch({ type: "boom" })).rejects.toBe(
      REHYDRATE_FAIL,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.error).toBe(REDUCE_BOOM);
    expect(seen[0]?.context.phase).toBe("reduce");

    await runtime.stop();
  });
});

describe("supervision: a non-throwing reducer is unaffected", () => {
  it("normal transitions behave identically under every strategy", async () => {
    for (const supervision of [
      undefined,
      "stop",
      "escalate",
      { strategy: "restart", rehydrate: () => ({ n: 0 }) },
    ] as const) {
      const runtime = await run(throwingMachine(), {
        ctx: undefined,
        onError: () => {},
        supervision,
      }).ready;
      await runtime.dispatch({ type: "inc" });
      await runtime.dispatch({ type: "inc" });
      expect(runtime.getState()).toEqual({ n: 2 });
      await runtime.stop();
    }
  });
});
