import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type BootingRuntime,
  Cmd,
  DriveFailedError,
  DriveStalledError,
  defineMachine,
  type Interpret,
  QuiescenceTimeoutError,
  type Reducer,
  type Runtime,
  type Store,
  StoreRefusedError,
  type Sub,
} from "./index";
import { memoryJournal, memoryStore } from "./mem";
import { eventSourcedStore } from "./persistence";
import { driveToDone, run } from "./promise";

// ───────────────────────────────────────────────────────────────────────────
// `driveToDone` (#57): one call from `start` to the terminal State, with the
// runtime stopped on every exit. Replaces the six-step loop — `await ready`,
// `observe`, park a promise, `dispatch`, `getState`, `stop` — whose failure
// modes were an observer left attached and a `stop` never awaited.
// ───────────────────────────────────────────────────────────────────────────

// A job that runs a fixed number of steps, driven by its own interpret
// follow-ups, then lands `done` — or `failed` when told to blow up.
type State = {
  readonly phase: "idle" | "running" | "done" | "failed";
  readonly steps: number;
};
type Msg =
  | { readonly _tag: "start" }
  | { readonly _tag: "step" }
  | { readonly _tag: "blow_up" };
type JobCmd = { readonly _tag: "next" } | { readonly _tag: "explode" };

function jobMachine() {
  const update: Reducer<State, Msg, JobCmd> = {
    start: (s) => [{ ...s, phase: "running" }, [{ _tag: "next" }]],
    step: (s) => {
      const steps = s.steps + 1;
      return steps >= 3
        ? [{ phase: "done", steps }, []]
        : [{ ...s, steps }, [{ _tag: "next" }]];
    },
    blow_up: (s) => [{ ...s, phase: "failed" }, []],
  };
  return defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      cmd: {} as JobCmd,
      ctx: undefined,
    },
    init: (loaded) => [loaded ?? { phase: "idle", steps: 0 }, []],
    update,
  });
}

const jobInterpret: Interpret<Msg, JobCmd, undefined> = {
  next: async () => ({ _tag: "step" }),
  explode: async () => ({ _tag: "blow_up" }),
};

const isDone = (s: State): boolean => s.phase === "done";
const isFailed = (s: State): boolean => s.phase === "failed";

// Wrap the handle `run()` returns so the test can read what the drive did to
// it: how many observers are attached right now, and whether `stop()` settled.
// Spreading the runtime is sound — its members are closures, not `this` users.
function instrument<S, M extends { _tag: string }>(
  handle: BootingRuntime<S, M>,
) {
  let attached = 0;
  let stopped = false;
  const observeCounting = (rt: BootingRuntime<S, M>) => ({
    observe(observer: (msg: M, state: S) => void): () => void {
      attached++;
      const off = rt.observe(observer);
      return () => {
        attached--;
        off();
      };
    },
  });
  const wrapped: BootingRuntime<S, M> = {
    ...handle,
    ...observeCounting(handle),
    ready: handle.ready.then(
      (rt): Runtime<S, M> => ({ ...rt, ...observeCounting(rt) }),
    ),
    async stop() {
      await handle.stop();
      stopped = true;
    },
  };
  return {
    handle: wrapped,
    get attached() {
      return attached;
    },
    get stopped() {
      return stopped;
    },
  };
}

describe("driveToDone — resolves with the terminal State (#57)", () => {
  it("against /mem: resolves done, leaves no observer, has awaited stop", async () => {
    const store = memoryStore<State>();
    const probe = instrument(
      run(jobMachine(), { ctx: undefined, interpret: jobInterpret, store }),
    );
    const before = probe.attached;

    const final = await driveToDone(probe.handle, { _tag: "start" }, isDone);

    expect(final).toEqual({ phase: "done", steps: 3 });
    expect(probe.attached).toBe(before);
    expect(probe.stopped).toBe(true);
    // `stop()` flushed the final State — the store read back by the next run is
    // the terminal one, which is only true if stop was awaited to completion.
    expect(await store.load()).toEqual(final);
  });

  it("a machine that boots already terminal resolves on the boot State; start is never dispatched", async () => {
    const store = memoryStore<State>({ phase: "done", steps: 3 });
    const probe = instrument(
      run(jobMachine(), { ctx: undefined, interpret: jobInterpret, store }),
    );
    const applied: string[] = [];
    probe.handle.observe((msg) => {
      applied.push(msg._tag);
    });

    const final = await driveToDone(probe.handle, { _tag: "start" }, isDone);

    expect(final).toEqual({ phase: "done", steps: 3 });
    expect(applied).toEqual([]);
    expect(probe.attached).toBe(1); // the test's own observer, nothing else
    expect(probe.stopped).toBe(true);
  });

  it("accepts an already-booted Runtime as the handle", async () => {
    const runtime = await run(jobMachine(), {
      ctx: undefined,
      interpret: jobInterpret,
    }).ready;
    const final = await driveToDone(runtime, { _tag: "start" }, isDone);
    expect(final.phase).toBe("done");
  });
});

describe("driveToDone — typed rejections (#57)", () => {
  it("a failed phase rejects with DriveFailedError carrying the final State", async () => {
    const probe = instrument(
      run(jobMachine(), { ctx: undefined, interpret: jobInterpret }),
    );

    const drive = driveToDone(probe.handle, { _tag: "blow_up" }, isDone, {
      failed: isFailed,
    });

    await expect(drive).rejects.toBeInstanceOf(DriveFailedError);
    await drive.catch((err: unknown) => {
      expect((err as DriveFailedError<State>).state).toEqual({
        phase: "failed",
        steps: 0,
      });
      expect((err as DriveFailedError<State>)._tag).toBe("DriveFailedError");
    });
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });

  it("a machine that never settles rejects on the existing quiescence cap", async () => {
    // A livelock: `start` emits `loop`, whose interpret follow-up `tick`
    // re-emits `loop`. No State is ever terminal, so the only way out is the
    // cap `dispatch` already rejects on — no second clock.
    type S2 = { readonly ticks: number };
    type M2 = { readonly _tag: "start" } | { readonly _tag: "tick" };
    type C2 = { readonly _tag: "loop" };
    const update: Reducer<S2, M2, C2> = {
      start: (s) => [s, [{ _tag: "loop" }]],
      tick: (s) => [{ ticks: s.ticks + 1 }, [{ _tag: "loop" }]],
    };
    const interpret: Interpret<M2, C2, undefined> = {
      loop: async () => ({ _tag: "tick" }),
    };
    const livelock = defineMachine({
      types: { model: {} as S2, msg: {} as M2, cmd: {} as C2, ctx: undefined },
      init: (_loaded) => [{ ticks: 0 }, []],
      update,
    });
    // The no-op `onError` absorbs the "runtime stopped" follow-up rejection the
    // in-flight loop produces once the drive tears the runtime down.
    const probe = instrument(
      run(livelock, {
        ctx: undefined,
        interpret,
        __idleCap: 25,
        onError: () => {},
      }),
    );

    await expect(
      driveToDone(probe.handle, { _tag: "start" }, () => false),
    ).rejects.toBeInstanceOf(QuiescenceTimeoutError);
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });

  it("a start chain that quiesces on a non-terminal State with nothing live rejects with DriveStalledError (#68)", async () => {
    // `start` parks the machine in `waiting` with no Cmd and no Sub: the chain
    // is quiescent, nothing inside the runtime can move it, and before #68 the
    // drive waited on that forever with `stop()` never reached.
    type S3 = { readonly phase: "idle" | "waiting" | "done" };
    type M3 = { readonly _tag: "start" } | { readonly _tag: "finish" };
    const update: Reducer<S3, M3, never> = {
      start: () => [{ phase: "waiting" }, []],
      finish: () => [{ phase: "done" }, []],
    };
    const parker = defineMachine({
      types: { model: {} as S3, msg: {} as M3, ctx: undefined },
      init: (_loaded) => [{ phase: "idle" }, []],
      update,
    });
    const probe = instrument(run(parker, { ctx: undefined }));

    const drive = driveToDone(
      probe.handle,
      { _tag: "start" },
      (s) => s.phase === "done",
    );

    await expect(drive).rejects.toBeInstanceOf(DriveStalledError);
    await drive.catch((err: unknown) => {
      expect((err as DriveStalledError<S3>).state).toEqual({
        phase: "waiting",
      });
      expect((err as DriveStalledError<S3>)._tag).toBe("DriveStalledError");
    });
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });

  describe("a Cmd handler that throws", () => {
    // `start` runs `first`, whose Msg moves the machine to `second`, and `second`
    // runs the Cmd that throws. The throw is on the second hop: nothing awaits
    // that dispatch, so it used to reach `onError` as a "follow-up" and leave the
    // drive to find nothing live and reject with a `DriveStalledError` instead.
    type S6 = {
      readonly phase: "idle" | "first" | "second" | "done" | "halted";
    };
    type M6 =
      | { readonly _tag: "start" }
      | { readonly _tag: "advance" }
      | { readonly _tag: "finish" }
      | { readonly _tag: "halt" };
    type C6 =
      | { readonly _tag: "first" }
      | { readonly _tag: "second" }
      | { readonly _tag: "third" };
    const update: Reducer<S6, M6, C6> = {
      start: () => [{ phase: "first" }, [{ _tag: "first" }]],
      advance: () => [{ phase: "second" }, [{ _tag: "second" }]],
      finish: () => [{ phase: "done" }, [{ _tag: "third" }]],
      halt: () => [{ phase: "halted" }, []],
    };
    const toy = defineMachine({
      types: { model: {} as S6, msg: {} as M6, cmd: {} as C6, ctx: undefined },
      init: (_loaded) => [{ phase: "idle" }, []],
      update,
    });
    // The same machine with a timer armed while it waits in `second`, so a live
    // Sub can still finish the run after the handler threw.
    const timed = defineMachine({
      types: { model: {} as S6, msg: {} as M6, cmd: {} as C6, ctx: undefined },
      init: (_loaded) => [{ phase: "idle" }, []],
      update,
      subs: [
        {
          _tag: "timer",
          deps: (s) =>
            s.phase === "second"
              ? { ms: 5, msg: { _tag: "finish" } as const }
              : null,
        },
      ],
    });
    const isDone6 = (s: S6): boolean => s.phase === "done";
    const boom = new Error("boom");
    const later = new Error("later");

    const noop: Interpret<M6, C6, undefined> = {
      first: async () => ({ _tag: "advance" }),
      second: async () => undefined,
      third: async () => undefined,
    };
    // A sink that keeps what it heard, in order, and the phase of each.
    const sink = () => {
      const heard: { error: unknown; phase: string }[] = [];
      return {
        heard,
        errors: () => heard.map(({ error }) => error),
        onError: (error: unknown, context: { readonly phase: string }) => {
          heard.push({ error, phase: context.phase });
        },
      };
    };
    // Let a rejection that lands after the drive returned reach the sink.
    const settleSink = () => new Promise<void>((done) => setTimeout(done, 0));

    it("rejects with the handler's own error when it throws on the second hop, and onError does not hear it", async () => {
      const heard = sink();
      const probe = instrument(
        run(toy, {
          ctx: undefined,
          interpret: {
            ...noop,
            second: async () => {
              throw boom;
            },
          },
          onError: heard.onError,
        }),
      );

      await expect(
        driveToDone(probe.handle, { _tag: "start" }, isDone6),
      ).rejects.toBe(boom);
      await settleSink();
      expect(heard.errors()).toEqual([]);
      expect(probe.attached).toBe(0);
      expect(probe.stopped).toBe(true);
    });

    it("rejects with the raw error when a Cmd.define'd handler throws on the second hop", async () => {
      // The engine catches a defined Cmd's throw and sends it to the sink, so
      // no dispatch ever rejects with it: the drive stalled on it unnamed.
      const first = Cmd.define("first", {
        input: z.object({ n: z.number() }),
        ok: z.object({ v: z.string() }),
        err: ["down"],
      });
      const second = Cmd.define("second", {
        input: z.object({ n: z.number() }),
        ok: z.object({ v: z.string() }),
        err: ["down"],
      });
      type S7 = { readonly phase: "idle" | "first" | "second" | "done" };
      const defined = defineMachine({
        types: { model: {} as S7, msg: {} as { readonly _tag: "start" } },
        cmds: [first, second],
        init: (loaded) => [loaded ?? { phase: "idle" }, []],
        update: {
          start: (s) => [{ ...s, phase: "first" }, [first({ n: 1 })]],
          first_ok: (s) => [{ ...s, phase: "second" }, [second({ n: 2 })]],
          first_err: (s) => [{ ...s, phase: "done" }, []],
          second_ok: (s) => [{ ...s, phase: "done" }, []],
          second_err: (s) => [{ ...s, phase: "done" }, []],
        },
      });
      const heard = sink();
      const probe = instrument(
        run(defined, {
          interpret: {
            first: async (_cmd, { ok }) => ok({ v: "x" }),
            second: async () => {
              throw boom;
            },
          },
          onError: heard.onError,
        }),
      );

      await expect(
        driveToDone(probe.handle, { _tag: "start" }, (s) => s.phase === "done"),
      ).rejects.toBe(boom);
      await settleSink();
      expect(heard.errors()).toEqual([]);
      expect(probe.stopped).toBe(true);
    });

    it("rejects with the same error when a hand-written handler throws on the first hop", async () => {
      const heard = sink();
      const probe = instrument(
        run(toy, {
          ctx: undefined,
          interpret: {
            ...noop,
            first: async () => {
              throw boom;
            },
          },
          onError: heard.onError,
        }),
      );

      await expect(
        driveToDone(probe.handle, { _tag: "start" }, isDone6),
      ).rejects.toBe(boom);
      await settleSink();
      expect(heard.errors()).toEqual([]);
      expect(probe.stopped).toBe(true);
    });

    it("rejects with the first held error and sends the others to onError, once each", async () => {
      const thrown = [boom, later];
      const heard = sink();
      const probe = instrument(
        run(toy, {
          ctx: undefined,
          interpret: {
            ...noop,
            // Two Msgs, so two hops each run `second`, and each throws.
            first: async () => [{ _tag: "advance" }, { _tag: "advance" }],
            second: async () => {
              throw thrown.shift();
            },
          },
          onError: heard.onError,
        }),
      );

      await expect(
        driveToDone(probe.handle, { _tag: "start" }, isDone6),
      ).rejects.toBe(boom);
      await settleSink();
      expect(heard.heard).toEqual([{ error: later, phase: "follow-up" }]);
    });

    it("resolves when a live Sub finishes the run after the handler threw, and onError hears the throw once", async () => {
      // The run was not stalled: a timer was armed. The drive keeps waiting, as
      // it always did, and the held throw goes to the sink when it resolves.
      const heard = sink();
      const probe = instrument(
        run(timed, {
          ctx: undefined,
          interpret: {
            ...noop,
            second: async () => {
              throw boom;
            },
          },
          onError: heard.onError,
        }),
      );

      await expect(
        driveToDone(probe.handle, { _tag: "start" }, isDone6),
      ).resolves.toEqual({ phase: "done" });
      await settleSink();
      expect(heard.heard).toEqual([{ error: boom, phase: "follow-up" }]);
      expect(probe.stopped).toBe(true);
    });

    it("resolves on the cancelled State when an abort lands while the handler is in flight, and onError hears the throw once", async () => {
      // The cancel Msg waits behind the step the handler is in. The handler
      // throws, the step ends, and the cancel folds: that is a cancelled run,
      // never a rejection (`{ signal, cancel }` never rejects on an abort).
      const controller = new AbortController();
      const heard = sink();
      const probe = instrument(
        run(toy, {
          ctx: undefined,
          interpret: {
            ...noop,
            second: async () => {
              controller.abort();
              await Promise.resolve();
              throw boom;
            },
          },
          onError: heard.onError,
        }),
      );

      await expect(
        driveToDone(
          probe.handle,
          { _tag: "start" },
          (s) => s.phase === "halted",
          { signal: controller.signal, cancel: () => ({ _tag: "halt" }) },
        ),
      ).resolves.toEqual({ phase: "halted" });
      await settleSink();
      expect(heard.heard).toEqual([{ error: boom, phase: "follow-up" }]);
    });

    it("resolves on a settling State, and onError hears a throw of that State's Cmd that lands after it", async () => {
      // `finish` lands the State the drive settles on, and its Cmd throws on a
      // later hop. The drive is already over by then, so the sink hears it.
      const heard = sink();
      const probe = instrument(
        run(toy, {
          ctx: undefined,
          interpret: {
            ...noop,
            second: async () => ({ _tag: "finish" }),
            third: async () => {
              throw boom;
            },
          },
          onError: heard.onError,
        }),
      );

      await expect(
        driveToDone(probe.handle, { _tag: "start" }, isDone6),
      ).resolves.toEqual({ phase: "done" });
      await settleSink();
      expect(heard.heard).toEqual([{ error: boom, phase: "follow-up" }]);
    });

    it("resolves on a settling State, and onError hears the first-hop throw of that State's Cmd", async () => {
      // The throw rejects `dispatch(start)`, but the settling State won the race
      // before it did, so the rejection has no caller left: it goes to the sink.
      type S8 = { readonly phase: "idle" | "done" };
      type M8 = { readonly _tag: "start" };
      type C8 = { readonly _tag: "notify" };
      const finishUpdate: Reducer<S8, M8, C8> = {
        start: () => [{ phase: "done" }, [{ _tag: "notify" }]],
      };
      const finishing = defineMachine({
        types: {
          model: {} as S8,
          msg: {} as M8,
          cmd: {} as C8,
          ctx: undefined,
        },
        init: (_loaded) => [{ phase: "idle" }, []],
        update: finishUpdate,
      });
      const heard = sink();
      const probe = instrument(
        run(finishing, {
          ctx: undefined,
          interpret: {
            notify: async () => {
              throw boom;
            },
          },
          onError: heard.onError,
        }),
      );

      await expect(
        driveToDone(probe.handle, { _tag: "start" }, (s) => s.phase === "done"),
      ).resolves.toEqual({ phase: "done" });
      await settleSink();
      expect(heard.heard).toEqual([{ error: boom, phase: "follow-up" }]);
    });

    it("leaves a store's refused save to onError, and the drive still stalls", async () => {
      // A save is not a Cmd handler: it is heard by the sink at once and the
      // drive has no cause to reject with.
      const saveFailure = new Error("storage refused");
      const inner = memoryStore<S6>();
      let saves = 0;
      const store: Store<S6> = {
        load: () => inner.load(),
        save: async (state, msg) => {
          saves += 1;
          // boot, `start`, then `advance`
          if (saves === 3) throw saveFailure;
          await inner.save(state, msg);
        },
        migrate: (raw) => inner.migrate(raw),
      };
      const heard = sink();
      const probe = instrument(
        run(toy, {
          ctx: undefined,
          interpret: noop,
          store,
          onError: heard.onError,
        }),
      );

      await expect(
        driveToDone(probe.handle, { _tag: "start" }, isDone6),
      ).rejects.toBeInstanceOf(DriveStalledError);
      await settleSink();
      expect(heard.heard).toEqual([{ error: saveFailure, phase: "follow-up" }]);
    });

    it("rejects the same way on a store that keeps a log", async () => {
      const heard = sink();
      const probe = instrument(
        run(toy, {
          ctx: undefined,
          store: eventSourcedStore(memoryJournal(), {
            state: z.object({
              phase: z.enum(["idle", "first", "second", "done", "halted"]),
            }),
            message: z.object({
              _tag: z.enum(["start", "advance", "finish", "halt"]),
            }),
            command: z.object({ _tag: z.enum(["first", "second", "third"]) }),
          }),
          interpret: {
            ...noop,
            second: async () => {
              throw boom;
            },
          },
          onError: heard.onError,
        }),
      );

      await expect(
        driveToDone(probe.handle, { _tag: "start" }, isDone6),
      ).rejects.toBe(boom);
      await settleSink();
      expect(heard.errors()).toEqual([]);
      expect(probe.stopped).toBe(true);
    });

    it("outside a drive, a second-hop throw still reaches onError as a follow-up and rejects nothing", async () => {
      const heard = sink();
      const runtime = await run(toy, {
        ctx: undefined,
        interpret: {
          ...noop,
          second: async () => {
            throw boom;
          },
        },
        onError: heard.onError,
      }).ready;

      await runtime.dispatch({ _tag: "start" });
      await runtime.stop();

      expect(heard.heard).toEqual([{ error: boom, phase: "follow-up" }]);
    });
  });

  it("a boot failure rejects with the boot error and still stops", async () => {
    // A store whose `load` throws is the boot failure that surfaces on `ready`,
    // as a refusal carrying the throw (#316).
    const boom = new Error("boot exploded");
    const store: Store<State> = {
      load: async () => {
        throw boom;
      },
      save: async () => {},
      migrate: () => null,
    };
    const probe = instrument(
      run(jobMachine(), {
        ctx: undefined,
        interpret: jobInterpret,
        store,
        onError: () => {},
      }),
    );

    const failure = await driveToDone(
      probe.handle,
      { _tag: "start" },
      isDone,
    ).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(StoreRefusedError);
    expect((failure as StoreRefusedError).cause).toBe(boom);
    expect(probe.stopped).toBe(true);
  });
});

// A Sub-driven machine is NOT stalled: the start dispatch quiesces on `waiting`,
// and the terminal Msg arrives later from the Sub the machine armed there. The
// stall gate (#68) must keep waiting for exactly this shape, both with a user
// runner and with the built-in timer.
describe("driveToDone — terminal arrives via a Sub after quiescence (#68)", () => {
  type S4 = { readonly phase: "idle" | "waiting" | "done" };
  type M4 = { readonly _tag: "start" } | { readonly _tag: "finish" };
  const update: Reducer<S4, M4, never> = {
    start: () => [{ phase: "waiting" }, []],
    finish: () => [{ phase: "done" }, []],
  };
  const isDone4 = (s: S4): boolean => s.phase === "done";
  // A one-shot timer that delivers `finish` on a later macrotask — after the
  // quiescent drain has already returned.
  const finishLater = (dispatch: (msg: M4) => void): (() => void) => {
    const timer = setTimeout(() => dispatch({ _tag: "finish" }), 5);
    return () => clearTimeout(timer);
  };

  it("a Sub with a user runner (`subscribe` at run): resolves with the State the Sub delivered", async () => {
    type U4 = Sub<"finish", { readonly armed: true }>;
    const machine = defineMachine({
      types: { model: {} as S4, msg: {} as M4, sub: {} as U4, ctx: undefined },
      init: (_loaded) => [{ phase: "idle" }, []],
      update,
      subs: [
        {
          _tag: "finish",
          deps: (s) => (s.phase === "waiting" ? { armed: true } : null),
        },
      ],
    });
    const probe = instrument(
      run(machine, {
        ctx: undefined,
        subscribe: { finish: (_sub, _ctx, dispatch) => finishLater(dispatch) },
      }),
    );

    const final = await driveToDone(probe.handle, { _tag: "start" }, isDone4);

    expect(final).toEqual({ phase: "done" });
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });

  it("the built-in `timer` Sub: resolves with the State the timer delivered", async () => {
    const machine = defineMachine({
      types: { model: {} as S4, msg: {} as M4, ctx: undefined },
      init: (_loaded) => [{ phase: "idle" }, []],
      update,
      subs: [
        {
          _tag: "timer",
          deps: (s) =>
            s.phase === "waiting"
              ? { ms: 5, msg: { _tag: "finish" } as const }
              : null,
        },
      ],
    });
    const probe = instrument(run(machine, { ctx: undefined }));

    const final = await driveToDone(probe.handle, { _tag: "start" }, isDone4);

    expect(final).toEqual({ phase: "done" });
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// #147 — `{ signal, cancel }`: the outside-in stop. Cancellation is a
// TRANSITION, so the drive resolves on the State the cancel Msg lands rather
// than throwing past a runtime nobody stopped.
// ───────────────────────────────────────────────────────────────────────────

describe("driveToDone — cancellation via an AbortSignal", () => {
  type S5 = { readonly phase: "idle" | "running" | "done" | "halted" };
  type M5 =
    | { readonly _tag: "start" }
    | { readonly _tag: "halt" }
    | { readonly _tag: "boom" };
  type C5 = { readonly _tag: "loop" };

  // A machine that never finishes on its own: every `start` re-enters itself
  // through an interpret follow-up, so only a cancel can end the drive.
  function looper(onLoop: () => void) {
    const update: Reducer<S5, M5, C5> = {
      start: (s) =>
        s.phase === "halted"
          ? [s, []]
          : [{ phase: "running" }, [{ _tag: "loop" }]],
      halt: () => [{ phase: "halted" }, []],
      // A cancel fold that throws instead of landing a State — the shape a
      // direct kernel consumer can hand `driveToDone` (#170).
      boom: () => {
        throw new Error("cancel fold blew up");
      },
    };
    const interpret: Interpret<M5, C5, undefined> = {
      loop: async () => {
        onLoop();
        return { _tag: "start" };
      },
    };
    const machine = defineMachine({
      types: { model: {} as S5, msg: {} as M5, cmd: {} as C5, ctx: undefined },
      init: (_loaded) => [{ phase: "idle" }, []],
      update,
    });
    return { machine, interpret };
  }

  // Run a looper; its handlers ride beside the machine into `run`.
  function runLooper(
    onLoop: () => void,
    opts: { readonly ctx: undefined; readonly onError?: () => void },
  ) {
    const { machine, interpret } = looper(onLoop);
    return run(machine, { ...opts, interpret });
  }

  const isEnded5 = (s: S5): boolean =>
    s.phase === "done" || s.phase === "halted";
  const cancel5 = () => ({ _tag: "halt" }) as const;

  it("an already-aborted signal cancels in place of `start`, so its effects never fire", async () => {
    let loops = 0;
    const controller = new AbortController();
    controller.abort();
    const probe = instrument(
      runLooper(
        () => {
          loops++;
        },
        { ctx: undefined },
      ),
    );

    const final = await driveToDone(probe.handle, { _tag: "start" }, isEnded5, {
      signal: controller.signal,
      cancel: cancel5,
    });

    expect(final).toEqual({ phase: "halted" });
    expect(loops).toBe(0);
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });

  it("an abort mid-run resolves on the cancelled State and stops the loop", async () => {
    let loops = 0;
    const controller = new AbortController();
    const probe = instrument(
      runLooper(
        () => {
          loops++;
          if (loops === 2) controller.abort();
        },
        { ctx: undefined },
      ),
    );

    const final = await driveToDone(probe.handle, { _tag: "start" }, isEnded5, {
      signal: controller.signal,
      cancel: cancel5,
    });

    expect(final).toEqual({ phase: "halted" });
    // The cancel Msg is enqueued on the same serial tail every dispatch uses, so
    // it lands between transitions: the work already queued folds, and nothing
    // the machine would have queued after it does. An unbounded loop is the
    // sharpest way to say that — without the stop this drive never returns.
    expect(loops).toBeLessThan(5);
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });

  it("resolves the cancellation even with a `failed` predicate wired", async () => {
    const controller = new AbortController();
    controller.abort();
    const probe = instrument(runLooper(() => {}, { ctx: undefined }));

    const final = await driveToDone(probe.handle, { _tag: "start" }, isEnded5, {
      // The drive does not add the cancelled State to the failure set behind the
      // caller's back: only a State THIS predicate marks rejects, and it does not
      // mark `halted`.
      failed: (s) => s.phase === "done",
      signal: controller.signal,
      cancel: cancel5,
    });

    expect(final).toEqual({ phase: "halted" });
  });

  // #170 — the cancel fold is the only thing that can land the terminal State
  // on an abort, so a throw there used to leave the drive awaiting a promise
  // nothing could resolve: no rejection, no `DriveStalledError`, a hang.
  const boom5 = () => ({ _tag: "boom" }) as const;

  it("an already-aborted signal whose cancel Msg throws rejects instead of hanging", async () => {
    const controller = new AbortController();
    controller.abort();
    const probe = instrument(
      runLooper(
        () => {},
        // The reduce throw reaches the sink too (invariant 6); the drive's
        // rejection is the claim under test, not the report.
        { ctx: undefined, onError: () => {} },
      ),
    );

    await expect(
      driveToDone(probe.handle, { _tag: "start" }, isEnded5, {
        signal: controller.signal,
        cancel: boom5,
      }),
    ).rejects.toThrow("cancel fold blew up");
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });

  it("an abort mid-run whose cancel Msg throws rejects too, `started` long since resolved", async () => {
    const controller = new AbortController();
    let loops = 0;
    const probe = instrument(
      runLooper(
        () => {
          loops++;
          if (loops === 2) controller.abort();
        },
        { ctx: undefined, onError: () => {} },
      ),
    );

    await expect(
      driveToDone(probe.handle, { _tag: "start" }, isEnded5, {
        signal: controller.signal,
        cancel: boom5,
      }),
    ).rejects.toThrow("cancel fold blew up");
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });

  // #174 — the same hang one frame earlier: the `cancel` FUNCTION throwing
  // synchronously, before it ever produces a Msg. `boom5` above is a cancel that
  // returns fine and blows up in the reducer; this one never returns at all, so
  // nothing is dispatched and `.catch` has no promise to attach to. Unreachable
  // through `defineAgent`, which supplies its own cancel; a direct kernel
  // consumer can hand it either shape.
  const throwingCancel = (): M5 => {
    throw new Error("cancel function blew up");
  };

  it("an abort mid-run whose cancel function throws synchronously rejects instead of hanging", async () => {
    const controller = new AbortController();
    let loops = 0;
    const probe = instrument(
      runLooper(
        () => {
          loops++;
          if (loops === 2) controller.abort();
        },
        // No cancel Msg is ever produced, so the loop is still turning when the
        // drive's `finally` stops the runtime and the in-flight `start` is
        // discarded. That discard is the expected shape of this exit; the sink
        // keeps the default warn out of the run, and the drive's rejection is
        // the claim under test.
        { ctx: undefined, onError: () => {} },
      ),
    );

    // Without containment the throw escapes the abort listener: no dispatch is
    // enqueued, so `terminal` is never resolved and this await never returns.
    await expect(
      driveToDone(probe.handle, { _tag: "start" }, isEnded5, {
        signal: controller.signal,
        cancel: throwingCancel,
      }),
    ).rejects.toThrow("cancel function blew up");
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });

  it("an already-aborted signal whose cancel function throws synchronously rejects the same way", async () => {
    const controller = new AbortController();
    controller.abort();
    const probe = instrument(runLooper(() => {}, { ctx: undefined }));

    await expect(
      driveToDone(probe.handle, { _tag: "start" }, isEnded5, {
        signal: controller.signal,
        cancel: throwingCancel,
      }),
    ).rejects.toThrow("cancel function blew up");
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });

  it("an already-aborted signal whose cancel lands a `failed` State rejects with DriveFailedError", async () => {
    const controller = new AbortController();
    controller.abort();
    const probe = instrument(runLooper(() => {}, { ctx: undefined }));

    // The already-aborted exit runs the same `failed` check every other exit
    // does: same inputs, one answer, whichever path reached the State.
    await expect(
      driveToDone(probe.handle, { _tag: "start" }, isEnded5, {
        failed: (s) => s.phase === "halted",
        signal: controller.signal,
        cancel: cancel5,
      }),
    ).rejects.toThrow(DriveFailedError);
    expect(probe.stopped).toBe(true);
  });
});
