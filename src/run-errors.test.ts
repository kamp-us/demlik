import { describe, expect, it, vi } from "vitest";
import {
  type Cmd,
  defineMachine,
  type Interpret,
  QuiescenceTimeoutError,
  type Reducer,
  type RuntimeErrorContext,
  run,
  type Store,
} from "./index";

// ───────────────────────────────────────────────────────────────────────────
// Errors-are-data: the runtime must surface its own failures, never swallow
// them (TEA invariant 6 — the runtime is inspectable; no silent failures).
//
// Three paths historically swallowed a real failure and returned clean:
//   1. `idle()` fell through and RESOLVED after its iteration cap — "quiesced"
//      was indistinguishable from "gave up".
//   2. `stop()` console.error'd a failed final `save` — silent loss of the
//      last write.
//   3. follow-up dispatch rejections went to `.catch(() => {})`.
//
// These tests pin the fix: (1) `idle()` rejects with `QuiescenceTimeoutError`;
// (2) + (3) route to the `onError` sink configured at `run({ onError })`.
// ───────────────────────────────────────────────────────────────────────────

describe("idle() rejects on quiescence timeout (no silent fall-through)", () => {
  // A livelock: the boot `init` emits `loop`; `loop`'s interpret handler
  // returns a `tick` follow-up; `tick`'s cell re-emits `loop`. The tail never
  // stabilizes, so `idle()` must hit its cap and REJECT rather than resolve.
  type State = { readonly ticks: number };
  type Msg = { readonly type: "tick" };
  type LoopCmd = { readonly type: "loop" };

  function livelockMachine() {
    const update: Reducer<State, Msg, LoopCmd> = {
      tick: (s) => [{ ticks: s.ticks + 1 }, [{ type: "loop" }]],
    };
    const interpret: Interpret<Msg, LoopCmd, undefined> = {
      // Every loop schedules another tick — the tail advances forever.
      loop: async () => ({ type: "tick" }),
    };
    return defineMachine<State, Msg, LoopCmd, never, undefined>({
      // Kick the loop off at boot.
      init: () => [{ ticks: 0 }, [{ type: "loop" }]],
      update,
      interpret,
    });
  }

  it("rejects with QuiescenceTimeoutError when the tail never stabilizes", async () => {
    // `__idleCap` keeps this fast — the production default is 100_000. The
    // no-op `onError` absorbs the expected "runtime stopped" follow-up
    // rejection that the in-flight livelock produces once we tear down.
    const runtime = await run(livelockMachine(), {
      ctx: undefined,
      __idleCap: 25,
      onError: () => {},
    }).ready;

    await expect(runtime.idle()).rejects.toBeInstanceOf(QuiescenceTimeoutError);
    await runtime.stop();
  });

  it("the rejection carries the iteration count it gave up at", async () => {
    const runtime = await run(livelockMachine(), {
      ctx: undefined,
      __idleCap: 25,
      onError: () => {},
    }).ready;

    await runtime.idle().then(
      () => {
        throw new Error("idle() resolved — expected a QuiescenceTimeoutError");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(QuiescenceTimeoutError);
        expect((err as QuiescenceTimeoutError).iterations).toBe(25);
      },
    );
    await runtime.stop();
  });

  it("still RESOLVES for a machine that genuinely quiesces", async () => {
    // Control: a finite follow-up chain reaches quiescence — idle() resolves.
    type S2 = { readonly n: number };
    type M2 = { readonly type: "step" } | { readonly type: "done" };
    type C2 = { readonly type: "advance" };
    const update: Reducer<S2, M2, C2> = {
      step: (s) => [{ n: s.n + 1 }, [{ type: "advance" }]],
      done: (s) => [s, []],
    };
    const interpret: Interpret<M2, C2, undefined> = {
      // One advance, then a terminal `done` — the chain ends.
      advance: async () => ({ type: "done" }),
    };
    const machine = defineMachine<S2, M2, C2, never, undefined>({
      init: () => [{ n: 0 }, []],
      update,
      interpret,
    });
    const runtime = await run(machine, { ctx: undefined, __idleCap: 25 }).ready;
    await runtime.dispatch({ type: "step" });
    await expect(runtime.idle()).resolves.toBeUndefined();
    await runtime.stop();
  });
});

describe("follow-up dispatch failures route to the onError sink", () => {
  const FOLLOW_UP_ERROR = new Error("follow-up interpret blew up");

  it("a follow-up Msg returned by interpret that fails reaches the sink", async () => {
    // This is the true swallowed path: interpret returns a follow-up Msg, the
    // runtime re-dispatches it on the tail, and THAT dispatch rejects with no
    // caller. Build a chain: kick → interpret returns `boom` → boom emits
    // `explode` → explode throws.
    type S2 = { readonly seen: boolean };
    type M2 = { readonly type: "kick" } | { readonly type: "boom" };
    type C2 = { readonly type: "trigger" } | { readonly type: "explode" };
    const update: Reducer<S2, M2, C2> = {
      kick: (s) => [s, [{ type: "trigger" }]],
      boom: (s) => [{ ...s }, [{ type: "explode" }]],
    };
    const interpret: Interpret<M2, C2, undefined> = {
      // `trigger` returns the `boom` follow-up Msg (caller-less re-dispatch).
      trigger: async () => ({ type: "boom" }),
      // `explode` throws — the follow-up `boom` dispatch rejects.
      explode: async () => {
        throw FOLLOW_UP_ERROR;
      },
    };
    const machine = defineMachine<S2, M2, C2, never, undefined>({
      init: () => [{ seen: false }, []],
      update,
      interpret,
    });

    const seen: { error: unknown; context: RuntimeErrorContext }[] = [];
    const runtime = await run(machine, {
      ctx: undefined,
      onError: (error, context) => seen.push({ error, context }),
    }).ready;

    // The original dispatch resolves (its own transition + the `trigger`
    // interpret succeed). The FOLLOW-UP `boom` is what fails, with no caller.
    await runtime.dispatch({ type: "kick" });
    // Let the follow-up chain settle.
    await runtime.idle().catch(() => {});
    await runtime.stop();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.error).toBe(FOLLOW_UP_ERROR);
    expect(seen[0]?.context.phase).toBe("follow-up");
  });
});

describe("stop-save failure routes to the onError sink (no silent data loss)", () => {
  type State = { readonly n: number };
  type Msg = { readonly type: "inc" };

  function counterMachine() {
    const update: Reducer<State, Msg, Cmd> = {
      inc: (s) => [{ n: s.n + 1 }, []],
    };
    return defineMachine<State, Msg, Cmd, never, undefined>({
      init: (loaded) => [(loaded as State | null) ?? { n: 0 }, []],
      update,
    });
  }

  it("invokes onError with the save error tagged phase 'stop-save'", async () => {
    const SAVE_ERROR = new Error("disk full on final flush");
    // Save succeeds during boot + transitions, then fails on the final stop
    // flush — pinning that the LAST write loss is what reaches the sink.
    let failNextSave = false;
    const store: Store<State> = {
      async load() {
        return null;
      },
      migrate: (raw) => (raw as State | null) ?? null,
      async save() {
        if (failNextSave) throw SAVE_ERROR;
      },
    };

    const seen: { error: unknown; context: RuntimeErrorContext }[] = [];
    const runtime = await run(counterMachine(), {
      ctx: undefined,
      store,
      onError: (error, context) => seen.push({ error, context }),
    }).ready;
    await runtime.dispatch({ type: "inc" });

    // Arm the failure for the stop-flush save only.
    failNextSave = true;
    // stop() must still RESOLVE (its contract) ...
    await expect(runtime.stop()).resolves.toBeUndefined();
    // ... but the lost write must have reached the sink.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.error).toBe(SAVE_ERROR);
    expect(seen[0]?.context.phase).toBe("stop-save");
  });

  it("a successful stop-save invokes the sink zero times", async () => {
    const store: Store<State> = {
      async load() {
        return null;
      },
      migrate: () => null,
      async save() {
        /* always succeeds */
      },
    };
    const onError = vi.fn();
    const runtime = await run(counterMachine(), {
      ctx: undefined,
      store,
      onError,
    }).ready;
    await runtime.dispatch({ type: "inc" });
    await runtime.stop();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("default onError (no sink) surfaces rather than swallows", () => {
  // With no sink, a follow-up failure must NOT vanish — the default re-throws
  // on a macrotask so it reaches the host's unhandled-rejection handler rather
  // than disappearing. Fake timers let us deterministically flush that
  // macrotask and assert the throw actually escapes (the "surface, never
  // swallow" default of invariant 6).
  type S = { readonly _: 0 };
  type M = { readonly type: "kick" } | { readonly type: "boom" };
  type C = { readonly type: "trigger" } | { readonly type: "explode" };

  const BOOM = new Error("follow-up boom, no sink");

  function machine() {
    const update: Reducer<S, M, C> = {
      kick: (s) => [s, [{ type: "trigger" }]],
      boom: (s) => [s, [{ type: "explode" }]],
    };
    const interpret: Interpret<M, C, undefined> = {
      trigger: async () => ({ type: "boom" }),
      explode: async () => {
        throw BOOM;
      },
    };
    return defineMachine<S, M, C, never, undefined>({
      init: () => [{ _: 0 }, []],
      update,
      interpret,
    });
  }

  it("re-throws the follow-up failure on a macrotask (does not silently swallow)", async () => {
    // Capture every macrotask the default sink schedules. `defaultOnError`
    // does `setTimeout(() => { throw error }, 0)`; we intercept that callback
    // instead of letting it become a process-level uncaught exception.
    const scheduled: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
    ) => {
      scheduled.push(fn);
      return 0 as unknown as ReturnType<typeof realSetTimeout>;
    }) as typeof setTimeout);

    try {
      const runtime = await run(machine(), { ctx: undefined }).ready;
      // Original dispatch resolves; the caller-less follow-up fails and is
      // handed to defaultOnError → scheduled here.
      await expect(runtime.dispatch({ type: "kick" })).resolves.toBeUndefined();
      await runtime.idle().catch(() => {});
      await runtime.stop();

      // The default scheduled exactly one re-throw — it did NOT swallow.
      expect(scheduled.length).toBeGreaterThanOrEqual(1);
      // Running the scheduled callback re-throws the original error: the
      // failure surfaces to the host's global handler in production.
      expect(() => {
        for (const fn of scheduled) fn();
      }).toThrow(BOOM);
    } finally {
      spy.mockRestore();
    }
  });
});
