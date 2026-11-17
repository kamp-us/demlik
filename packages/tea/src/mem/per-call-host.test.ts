import { describe, expect, it } from "vitest";
import { DispatchDiscardedError, DrainTimeoutNotice } from "../index";
import { type LiveWorkProbe, liveWork } from "../internal/engine/loop";
import {
  type AnswerBoot,
  answerHostTests,
  answerMachine,
  type Boot,
  complete,
  type JobBoot,
  jobMachine,
  machine,
  measured,
  owedHostTests,
  perCallHostTests,
  storeFor,
} from "../internal/persistence/per-call-host.fixture";
import { run } from "../promise";
import { subscribeWith } from "../resilience";
import { memoryJournal } from "./index";

const boot: Boot = async (store, options = {}) => {
  const deadline = subscribeWith(() => () => {});
  const host = await run(machine(options.timer), {
    store,
    disposeTimeoutMs: 40,
    onError: (error) => options.errors?.push(error),
    interpret: { complete: options.handle ?? complete },
    subscribe: {
      deadline: options.dispose
        ? (...args) => {
            const dispose = deadline(...args);
            return async () => {
              dispose();
              await options.dispose?.();
            };
          }
        : deadline,
    },
  }).ready;
  return {
    dispatch: (msg, opts) => host.dispatch(msg, opts),
    getState: () => host.getState(),
    stop: () => host.stop(),
    live: () => (host as typeof host & LiveWorkProbe)[liveWork](),
  };
};

perCallHostTests("promise", boot);

const bootJob: JobBoot = async (store, handle, errors) => {
  const host = await run(jobMachine(), {
    store,
    onError: (error, { phase }) => errors?.push({ error, phase }),
    interpret: { job: handle },
  }).ready;
  return {
    dispatch: (msg) => host.dispatch(msg),
    getState: () => host.getState(),
    stop: () => host.stop(),
    live: () => (host as typeof host & LiveWorkProbe)[liveWork](),
  };
};

owedHostTests("promise", bootJob);

const bootAnswer: AnswerBoot = async (store, handle, reject, beforeReady) => {
  const booting = run(answerMachine(reject), {
    store,
    interpret: { job: handle },
    subscribe: { deadline: subscribeWith(() => () => {}) },
    onError: () => {},
  });
  await beforeReady?.(booting);
  const host = await booting.ready;
  return {
    dispatch: (msg, options) => host.dispatch(msg, options),
    getState: () => host.getState(),
    stop: () => host.stop(),
    live: () => (host as typeof host & LiveWorkProbe)[liveWork](),
  };
};

answerHostTests("promise", bootAnswer);

describe("ADR 0025: an unfinished Promise handler outlives bounded stop", () => {
  it("leaves its handler, timer and dispatch pending, then drops its late result", async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const errors: unknown[] = [];
    let sending!: Promise<void>;
    let dispatchSettled = false;
    let handlerPending = false;
    let host!: Awaited<ReturnType<Boot>>;
    const journal = memoryJournal();
    try {
      const sample = await measured(async () => {
        host = await boot(storeFor(journal), {
          errors,
          handle: async (cmd) => {
            handlerPending = true;
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 60_000);
              release = () => {
                clearTimeout(timer);
                resolve();
              };
              started();
            });
            handlerPending = false;
            return complete(cmd);
          },
        });
        sending = host.dispatch({ _tag: "step", call: 0, part: 0 });
        void sending.then(
          () => {
            dispatchSettled = true;
          },
          () => {
            dispatchSettled = true;
          },
        );
        await entered;
        await host.stop();
        await journal.close();
      });
      expect(sample.resources.handles).toBe(0);
      expect(sample.resources.timers).toBe(1);
      expect(sample.resources.promises).toBeGreaterThan(0);
      expect(sample.resources.fibers).toBe(0);
      expect(host.live()).toEqual({ subs: 0, cmds: 1 });
      expect(handlerPending).toBe(true);
      expect(dispatchSettled).toBe(false);
      expect(errors.some((e) => e instanceof DrainTimeoutNotice)).toBe(true);
      release();
      await sending;
      expect(errors.some((e) => e instanceof DispatchDiscardedError)).toBe(
        true,
      );
      expect(handlerPending).toBe(false);
      expect(host.getState().completed).toEqual([]);
    } finally {
      release?.();
      await sending?.catch(() => {});
      await host?.stop();
    }
  });
});
