import { describe, expect, it } from "vitest";
import {
  defineMachine,
  type Interpret,
  type Reducer,
  type Store,
} from "./index";
import { memoryStore } from "./mem";
import { run } from "./promise";

// `run({ cancellation })`: the stop for a host that holds the runtime itself.
// Once the signal aborts the runtime queues the cancel Msg, starts no further
// Cmd and stops waiting on the handler in flight, so the stop does not wait for
// work a promise cannot recall.

type State = {
  readonly phase: "idle" | "working" | "done" | "halted";
  readonly folded: number;
};
type Msg =
  | { readonly _tag: "start" }
  | { readonly _tag: "worked" }
  | { readonly _tag: "halt" }
  | { readonly _tag: "boom" };
type Cmd = { readonly _tag: "work" };

const REPEATS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const halt = (): Msg => ({ _tag: "halt" });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

const parked = () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
};

function machine(initCmds: readonly Cmd[] = []) {
  const update: Reducer<State, Msg, Cmd> = {
    start: (s) =>
      s.phase === "idle"
        ? [{ ...s, phase: "working", folded: s.folded + 1 }, [{ _tag: "work" }]]
        : [s, []],
    worked: (s) =>
      s.phase === "working"
        ? [{ ...s, phase: "done", folded: s.folded + 1 }, []]
        : [s, []],
    halt: (s) =>
      s.phase === "done" || s.phase === "halted"
        ? [s, []]
        : [{ ...s, phase: "halted", folded: s.folded + 1 }, []],
    boom: () => {
      throw new Error("the cancel fold blew up");
    },
  };
  return defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      cmd: {} as Cmd,
      ctx: undefined,
    },
    init: (loaded) => [loaded ?? { phase: "idle", folded: 0 }, initCmds],
    update,
  });
}

function handlers(onWork: () => Promise<void>) {
  const calls: string[] = [];
  const interpret: Interpret<Msg, Cmd, undefined> = {
    work: async () => {
      calls.push("work");
      await onWork();
      return { _tag: "worked" };
    },
  };
  return { calls, interpret };
}

describe.each(REPEATS)("run({ cancellation }) (repeat %i)", () => {
  it("settles the cancel before ready when the signal is already aborted, and boot starts no Cmd", async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls, interpret } = handlers(async () => {});

    const runtime = await run(machine([{ _tag: "work" }]), {
      ctx: undefined,
      interpret,
      cancellation: { signal: controller.signal, cancel: halt },
    }).ready;

    expect(runtime.getState().phase).toBe("halted");
    expect(calls).toEqual([]);
    await runtime.stop();
  });

  it("settles the cancel before ready when the signal aborts while the store loads", async () => {
    const controller = new AbortController();
    const load = parked();
    const backing = memoryStore<State>();
    const store: Store<State> = {
      ...backing,
      load: async () => {
        await load.held;
        return backing.load();
      },
    };
    const { calls, interpret } = handlers(async () => {});
    const booting = run(machine([{ _tag: "work" }]), {
      ctx: undefined,
      interpret,
      store,
      cancellation: { signal: controller.signal, cancel: halt },
    });

    await tick();
    controller.abort();
    load.release();
    const runtime = await booting.ready;

    expect(runtime.getState().phase).toBe("halted");
    expect(calls).toEqual([]);
    await runtime.stop();
  });

  it("takes the run off a parked handler, so the cancel folds and the late result is dropped", async () => {
    const controller = new AbortController();
    const work = parked();
    const { calls, interpret } = handlers(() => work.held);
    const runtime = await run(machine(), {
      ctx: undefined,
      interpret,
      cancellation: { signal: controller.signal, cancel: halt },
    }).ready;

    const started = runtime.dispatch({ _tag: "start" });
    started.catch(() => {});
    while (calls.length === 0) await tick();
    controller.abort();
    await tick();

    expect(runtime.getState().phase).toBe("halted");
    work.release();
    await tick();
    expect(runtime.getState().phase).toBe("halted");
    expect(runtime.getState().folded).toBe(2);
    await runtime.stop();
  });

  it("starts no Cmd of a transition whose save the abort overtook", async () => {
    const controller = new AbortController();
    const save = parked();
    const backing = memoryStore<State>();
    let saves = 0;
    const store: Store<State> = {
      ...backing,
      save: async (state) => {
        if (++saves === 2) await save.held;
        await backing.save(state);
      },
    };
    const { calls, interpret } = handlers(async () => {});
    const runtime = await run(machine(), {
      ctx: undefined,
      interpret,
      store,
      cancellation: { signal: controller.signal, cancel: halt },
    }).ready;

    const started = runtime.dispatch({ _tag: "start" });
    started.catch(() => {});
    await tick();
    controller.abort();
    save.release();
    await tick();

    expect(runtime.getState().phase).toBe("halted");
    expect(calls).toEqual([]);
    await runtime.stop();
  });

  it("reports a cancel that throws to onError instead of dropping it", async () => {
    const controller = new AbortController();
    const reports: unknown[] = [];
    const { interpret } = handlers(async () => {});
    const runtime = await run(machine(), {
      ctx: undefined,
      interpret,
      onError: (error) => reports.push(error),
      cancellation: {
        signal: controller.signal,
        cancel: (): Msg => ({ _tag: "boom" }),
      },
    }).ready;

    controller.abort();
    await tick();

    expect(reports).toHaveLength(1);
    expect(runtime.getState().phase).toBe("idle");
    await runtime.stop();
  });

  it("is refused with a store that keeps a log", () => {
    const store = Object.assign(memoryStore<State>(), {
      logged: true as const,
    });
    const { interpret } = handlers(async () => {});

    expect(() =>
      run(machine(), {
        ctx: undefined,
        interpret,
        store,
        cancellation: { signal: new AbortController().signal, cancel: halt },
      }),
    ).toThrow("`cancellation` is not available with a store that keeps a log");
  });
});
