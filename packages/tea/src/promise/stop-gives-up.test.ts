/**
 * `stop()` gives up on a Cmd handler that has not returned (ADR 0025). It waits
 * for the queue up to `disposeTimeoutMs`, reports what it left behind, then
 * stops the Subs, runs the final save and returns. Work that surfaces after
 * that is dropped: nothing more is saved and no further handler starts.
 */

import { describe, expect, it } from "vitest";
import {
  DispatchDiscardedError,
  DrainTimeoutNotice,
  defineMachine,
  type NoCtx,
  RuntimeDiscardedError,
  type RuntimeErrorContext,
  type Store,
  type Sub,
} from "../index";
import { memoryStore } from "../mem";
import { run } from "./index";

type Feed = Sub<"feed", { readonly on: true }>;
type Model = { readonly asked: number; readonly got: number };
type Msg =
  | { readonly type: "ask" }
  | { readonly type: "got" }
  | { readonly type: "bump" };
type Cmd = { readonly type: "wait" } | { readonly type: "after" };

const machine = defineMachine({
  types: {
    model: {} as Model,
    msg: {} as Msg,
    cmd: {} as Cmd,
    sub: {} as Feed,
    ctx: {} as NoCtx,
  },
  init: (loaded) => [loaded ?? { asked: 0, got: 0 }, []],
  update: {
    ask: (s) => [
      { ...s, asked: s.asked + 1 },
      [{ type: "wait" }, { type: "after" }],
    ],
    got: (s) => [{ ...s, got: s.got + 1 }, []],
    bump: (s) => [{ ...s, got: s.got + 100 }, []],
  },
  subs: [{ type: "feed", deps: () => ({ on: true as const }) }],
});

const LIMIT_MS = 40;

/** One run with a store, a running Sub and a `wait` handler the test holds. */
async function startRun() {
  const inner = memoryStore<Model>(null);
  const saves: Model[] = [];
  const store: Store<Model> = {
    load: () => inner.load(),
    migrate: (raw) => inner.migrate(raw),
    async save(state) {
      saves.push(state);
      await inner.save(state);
    },
  };
  const reports: { error: unknown; phase: string }[] = [];
  const started: string[] = [];
  let subCleanups = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = await run(machine, {
    store,
    disposeTimeoutMs: LIMIT_MS,
    onError: (error: unknown, context: RuntimeErrorContext) => {
      reports.push({ error, phase: context.phase });
    },
    interpret: {
      wait: async () => {
        started.push("wait");
        await held;
        return { type: "got" } as const;
      },
      after: () => {
        started.push("after");
      },
    },
    subscribe: {
      feed: () => () => {
        subCleanups++;
      },
    },
  }).ready;
  // The step saves, then its `wait` handler starts and never returns.
  const asked = runtime.dispatchOnce({ type: "ask" });
  while (started.length === 0) await Promise.resolve();
  return {
    runtime,
    asked,
    saves,
    reports,
    started,
    release,
    subCleanups: () => subCleanups,
  };
}

describe("Promise engine: stop() with a Cmd handler that never returns", () => {
  it("three runs stopped at once each return within the limit, with the Sub cleaned up and the final save run", async () => {
    const runs = await Promise.all([startRun(), startRun(), startRun()]);
    const savesBefore = runs.map((r) => r.saves.length);

    const began = performance.now();
    await Promise.all(runs.map((r) => r.runtime.stop()));
    const elapsed = performance.now() - began;

    // One limit, not three: the runs give up side by side. The upper bound is
    // loose so a slow machine does not flake; the handlers never return at all.
    expect(elapsed).toBeGreaterThanOrEqual(LIMIT_MS - 5);
    expect(elapsed).toBeLessThan(LIMIT_MS + 1_000);

    for (const [i, r] of runs.entries()) {
      expect(r.subCleanups()).toBe(1);
      expect(r.saves.length).toBe((savesBefore[i] as number) + 1);
      expect(r.saves.at(-1)).toEqual({ asked: 1, got: 0 });
      expect(r.reports).toEqual([
        { error: expect.any(RuntimeDiscardedError), phase: "discard" },
        { error: expect.any(DrainTimeoutNotice), phase: "discard" },
      ]);
      const notice = r.reports[1]?.error as DrainTimeoutNotice;
      expect(notice.cmdTypes).toEqual(["wait"]);
      expect(notice.pendingCmds).toBe(1);
      expect(notice.timeoutMs).toBe(LIMIT_MS);
    }
  });

  it("drops the stuck handler's late result, the rest of its step and the Msgs queued behind it", async () => {
    const r = await startRun();
    // Accepted while the run was open, queued behind the stuck handler.
    const queued = r.runtime.dispatchOnce({ type: "bump" });
    const queuedOutcome = queued.then(
      () => "folded",
      (error: unknown) => error,
    );

    await r.runtime.stop();
    const savesAtStop = r.saves.length;
    const stateAtStop = r.runtime.getState();

    // The handler returns after stop() has: its Msg, the step's next Cmd and
    // the queued Msg all surface now.
    r.release();
    await r.asked;
    expect(await queuedOutcome).toBeInstanceOf(DispatchDiscardedError);

    expect(r.saves.length).toBe(savesAtStop);
    expect(r.started).toEqual(["wait"]);
    expect(r.runtime.getState()).toBe(stateAtStop);
    expect(r.reports.map((report) => report.phase)).toEqual([
      "discard",
      "discard",
      "discard",
    ]);
    expect(r.reports[2]?.error).toBeInstanceOf(DispatchDiscardedError);
    expect((r.reports[2]?.error as DispatchDiscardedError).msgType).toBe("got");
    // A caller using the retired run is still told so, loudly.
    await expect(r.runtime.dispatch({ type: "bump" })).rejects.toThrow(
      "runtime stopped",
    );
  });

  it("a second stop() does not report the abandoned handler a second time", async () => {
    const r = await startRun();
    await r.runtime.stop();
    await r.runtime.stop();
    expect(
      r.reports.filter((report) => report.error instanceof DrainTimeoutNotice),
    ).toHaveLength(1);
  });
});
