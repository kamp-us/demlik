import { describe, expect, it } from "vitest";
import {
  type BootingRuntime,
  DriveFailedError,
  defineMachine,
  driveToDone,
  type Interpret,
  QuiescenceTimeoutError,
  type Reducer,
  type Runtime,
  run,
  type Store,
} from "./index";
import { memoryStore } from "./mem";

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
  | { readonly type: "start" }
  | { readonly type: "step" }
  | { readonly type: "blow_up" };
type JobCmd = { readonly type: "next" } | { readonly type: "explode" };

function jobMachine() {
  const update: Reducer<State, Msg, JobCmd> = {
    start: (s) => [{ ...s, phase: "running" }, [{ type: "next" }]],
    step: (s) => {
      const steps = s.steps + 1;
      return steps >= 3
        ? [{ phase: "done", steps }, []]
        : [{ ...s, steps }, [{ type: "next" }]];
    },
    blow_up: (s) => [{ ...s, phase: "failed" }, []],
  };
  const interpret: Interpret<Msg, JobCmd, undefined> = {
    next: async () => ({ type: "step" }),
    explode: async () => ({ type: "blow_up" }),
  };
  return defineMachine<State, Msg, JobCmd, never, undefined>({
    init: (loaded) => [loaded ?? { phase: "idle", steps: 0 }, []],
    update,
    interpret,
  });
}

const isDone = (s: State): boolean => s.phase === "done";
const isFailed = (s: State): boolean => s.phase === "failed";

// Wrap the handle `run()` returns so the test can read what the drive did to
// it: how many observers are attached right now, and whether `stop()` settled.
// Spreading the runtime is sound — its members are closures, not `this` users.
function instrument<S, M extends { type: string }>(
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
    const probe = instrument(run(jobMachine(), { ctx: undefined, store }));
    const before = probe.attached;

    const final = await driveToDone(probe.handle, { type: "start" }, isDone);

    expect(final).toEqual({ phase: "done", steps: 3 });
    expect(probe.attached).toBe(before);
    expect(probe.stopped).toBe(true);
    // `stop()` flushed the final State — the store read back by the next run is
    // the terminal one, which is only true if stop was awaited to completion.
    expect(await store.load()).toEqual(final);
  });

  it("a machine that boots already terminal resolves on the boot State; start is never dispatched", async () => {
    const store = memoryStore<State>({ phase: "done", steps: 3 });
    const probe = instrument(run(jobMachine(), { ctx: undefined, store }));
    const applied: string[] = [];
    probe.handle.observe((msg) => {
      applied.push(msg.type);
    });

    const final = await driveToDone(probe.handle, { type: "start" }, isDone);

    expect(final).toEqual({ phase: "done", steps: 3 });
    expect(applied).toEqual([]);
    expect(probe.attached).toBe(1); // the test's own observer, nothing else
    expect(probe.stopped).toBe(true);
  });

  it("accepts an already-booted Runtime as the handle", async () => {
    const runtime = await run(jobMachine(), { ctx: undefined }).ready;
    const final = await driveToDone(runtime, { type: "start" }, isDone);
    expect(final.phase).toBe("done");
  });
});

describe("driveToDone — typed rejections (#57)", () => {
  it("a failed phase rejects with DriveFailedError carrying the final State", async () => {
    const probe = instrument(run(jobMachine(), { ctx: undefined }));

    const drive = driveToDone(probe.handle, { type: "blow_up" }, isDone, {
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
    type M2 = { readonly type: "start" } | { readonly type: "tick" };
    type C2 = { readonly type: "loop" };
    const update: Reducer<S2, M2, C2> = {
      start: (s) => [s, [{ type: "loop" }]],
      tick: (s) => [{ ticks: s.ticks + 1 }, [{ type: "loop" }]],
    };
    const interpret: Interpret<M2, C2, undefined> = {
      loop: async () => ({ type: "tick" }),
    };
    const livelock = defineMachine<S2, M2, C2, never, undefined>({
      init: () => [{ ticks: 0 }, []],
      update,
      interpret,
    });
    // The no-op `onError` absorbs the "runtime stopped" follow-up rejection the
    // in-flight loop produces once the drive tears the runtime down.
    const probe = instrument(
      run(livelock, { ctx: undefined, __idleCap: 25, onError: () => {} }),
    );

    await expect(
      driveToDone(probe.handle, { type: "start" }, () => false),
    ).rejects.toBeInstanceOf(QuiescenceTimeoutError);
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });

  it("a boot failure rejects with the boot error and still stops", async () => {
    // A store whose `load` throws is the boot failure that surfaces on `ready`.
    const boom = new Error("boot exploded");
    const store: Store<State> = {
      load: async () => {
        throw boom;
      },
      save: async () => {},
      migrate: () => null,
    };
    const probe = instrument(
      run(jobMachine(), { ctx: undefined, store, onError: () => {} }),
    );

    await expect(
      driveToDone(probe.handle, { type: "start" }, isDone),
    ).rejects.toBe(boom);
    expect(probe.stopped).toBe(true);
  });
});
