/**
 * `tell` on the Promise engine (#639): it queues and returns, so machines that
 * answer each other from Cmd handlers keep moving.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type LineMsg,
  type LineState,
  line,
  ping,
  type RingChildMsg,
  type RingChildState,
  type RingParentMsg,
  type RingParentState,
  ringChild,
  ringParent,
} from "../__fixtures__/answering-machines";
import { replay, type Store } from "../index";
import { memoryStore } from "../mem";
import { type Runtime, RuntimeDiscardedError } from "../runtime-types";
import { run, tell } from "./index";

const ROUNDS = 100;
const LIMIT_MS = 10_000;

/** `work`, or a failure once `LIMIT_MS` has passed: a stopped ring fails here. */
const within = async <A>(work: Promise<A>): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer in ${LIMIT_MS} ms`)),
          LIMIT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** A macrotask later: past the default sink's `setTimeout(0)` rethrow. */
const nextMacrotask = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A `line` run with a `wait` handler the test releases, and what it reported. */
const openLine = async (store?: Store<LineState>) => {
  const reports: unknown[] = [];
  let release = () => {};
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = await run(line, {
    store,
    onError: (error) => void reports.push(error),
    interpret: {
      wait: async () => {
        entered();
        await gate;
      },
    },
  }).ready;
  return { runtime, reports, started, release };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tell on the Promise engine", () => {
  it(
    "one parent and three children answering each other from Cmd handlers, 100 round trips each: all finish, and each log replays to the same State",
    async () => {
      const ids = ["a", "b", "c"];
      const parent = ringParent(ids, ROUNDS);
      const parentLog: RingParentMsg[] = [];
      const children = new Map<
        string,
        {
          readonly machine: ReturnType<typeof ringChild>;
          readonly run: Runtime<RingChildState, RingChildMsg>;
          readonly log: RingChildMsg[];
        }
      >();
      const finished = (state: { readonly type: string }) =>
        state.type === "finished";

      const parentRun = await run(parent, {
        terminal: finished,
        interpret: {
          answer_back: async (cmd) => {
            const child = children.get(cmd.id);
            if (child === undefined) throw new Error(`no child ${cmd.id}`);
            tell(child.machine, child.run, {
              type: "answer",
              round: cmd.round,
            });
          },
        },
      }).ready;
      parentRun.observe((msg) => void parentLog.push(msg));

      for (const id of ids) {
        const machine = ringChild(id, ROUNDS);
        const log: RingChildMsg[] = [];
        const childRun = await run(machine, {
          terminal: finished,
          interpret: {
            report: async (cmd) => {
              tell(parent, parentRun, {
                type: "child_result",
                id: cmd.id,
                round: cmd.round,
              });
            },
          },
        }).ready;
        childRun.observe((msg) => void log.push(msg));
        children.set(id, { machine, run: childRun, log });
      }

      for (const child of children.values()) {
        expect(tell(child.machine, child.run, { type: "begin" })).toBe(
          "queued",
        );
      }

      const parentFinal: RingParentState = await within(parentRun.done());
      const expected = { a: ROUNDS, b: ROUNDS, c: ROUNDS };
      expect(parentFinal).toEqual({ type: "finished", reports: expected });
      expect(replay(parent, { msgs: parentLog, ctx: {} }).state).toEqual(
        parentFinal,
      );

      for (const child of children.values()) {
        const childFinal = await within(child.run.done());
        expect(childFinal).toEqual({ type: "finished", answered: ROUNDS });
        expect(child.log).toHaveLength(ROUNDS + 1);
        expect(
          replay(child.machine, { msgs: child.log, ctx: {} }).state,
        ).toEqual(childFinal);
        await child.run.stop();
      }
      await parentRun.stop();
    },
    2 * LIMIT_MS,
  );

  it("returns before the receiver's step runs: with its handler held, `tell` has answered and the Msg folds once it is released", async () => {
    const { runtime, started, release } = await openLine();
    const held = runtime.dispatch({ type: "hold" });
    await started;

    expect(tell(line, runtime, ping("a"))).toBe("queued");
    // A step's own turn comes after the handler ahead of it.
    await nextMacrotask();
    expect(runtime.getState().folded).toEqual([]);

    release();
    await held;
    await runtime.idle();
    expect(runtime.getState().folded).toEqual(["a"]);
    await runtime.stop();
  });

  it("does not run the step on the sender's stack, even on an idle receiver", async () => {
    const { runtime } = await openLine();
    expect(tell(line, runtime, ping("a"))).toBe("queued");
    expect(runtime.getState().folded).toEqual([]);
    await runtime.idle();
    expect(runtime.getState().folded).toEqual(["a"]);
    await runtime.stop();
  });

  it("tells from one sender fold in the order they were sent, behind a held handler", async () => {
    const { runtime, started, release } = await openLine();
    const held = runtime.dispatch({ type: "hold" });
    await started;
    const names = Array.from({ length: 50 }, (_, i) => `n${i}`);
    for (const name of names) tell(line, runtime, ping(name));
    release();
    await held;
    await runtime.idle();
    expect(runtime.getState().folded).toEqual(names);
    await runtime.stop();
  });

  it("answers `stopped` for a run that has stopped, and for one that is stopping", async () => {
    const { runtime, started, release, reports } = await openLine();
    const held = runtime.dispatch({ type: "hold" });
    await started;

    const stopping = runtime.stop();
    expect(tell(line, runtime, ping("while stopping"))).toBe("stopped");

    release();
    await held;
    await stopping;
    expect(tell(line, runtime, ping("after"))).toBe("stopped");
    expect(runtime.getState().folded).toEqual([]);
    // Only the notice that a handler was in flight at `stop()`.
    expect(reports).toEqual([expect.any(RuntimeDiscardedError)]);
  });

  it("answers `stopped` ahead of `no_cell`: a stopped run says it stopped, whatever its State", async () => {
    const { runtime } = await openLine();
    await runtime.dispatch({ type: "close" });
    await runtime.stop();
    expect(tell(line, runtime, ping("a"))).toBe("stopped");
  });

  it("answers `no_cell` when the current State has no cell, and sends nothing", async () => {
    const { runtime, reports } = await openLine();
    const seen: string[] = [];
    runtime.observe((msg) => void seen.push(msg.type));
    await runtime.dispatch({ type: "close" });

    expect(tell(line, runtime, ping("a"))).toBe("no_cell");
    await runtime.idle();

    expect(seen).toEqual(["close"]);
    expect(reports).toEqual([]);
    await runtime.stop();
  });

  it("a Msg whose cell is gone by its turn does not end the process when the host passed no `onError`, and the run keeps going", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = await run(line, {
      interpret: { wait: async () => {} },
    }).ready;
    // `close` is queued, not folded, so the check still reads `open`.
    const closing = runtime.dispatch({ type: "close" });
    expect(tell(line, runtime, ping("late"))).toBe("queued");
    await closing;
    await runtime.idle();
    // The default sink rethrows on a macrotask: vitest fails on that throw.
    await nextMacrotask();

    expect(runtime.getState()).toEqual({ type: "closed", folded: [] });
    expect(warned).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it("a failed save of the receiver reaches its `onError`, and the sender only ever heard `queued`", async () => {
    const disk = new Error("disk full");
    const inner = memoryStore<LineState>();
    let full = false;
    const store: Store<LineState> = {
      load: () => inner.load(),
      save: async (state) => {
        if (full) throw disk;
        await inner.save(state);
      },
      migrate: (raw) => inner.migrate(raw),
    };
    const { runtime, reports } = await openLine(store);
    full = true;

    expect(tell(line, runtime, ping("a"))).toBe("queued");
    await runtime.idle();

    expect(reports).toEqual([disk]);
    full = false;
    await runtime.stop();
  });

  it("refuses a handle that did not come from `run`, loudly", () => {
    const handBuilt = {} as Runtime<LineState, LineMsg>;
    expect(() => tell(line, handBuilt, ping("a"))).toThrow(
      /run handle from `run`/,
    );
  });
});
