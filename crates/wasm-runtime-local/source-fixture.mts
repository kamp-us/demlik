import {
  defineMachine,
  type NoCtx,
  type Reducer,
  type Store,
  type Sub,
  type TimerSub,
} from "../../packages/tea/src/index";
import { driveToDone, run } from "../../packages/tea/src/promise";
import { detachWorkOf } from "../../packages/tea/src/pure/core";

type Model = { type: "state"; count: number; timer: number | null };
type Msg =
  | { type: "add"; by: number }
  | { type: "work" | "background" }
  | { type: "arm"; ms: number | null }
  | { type: "tick" };
type Cmd = { type: "work" } | { type: "background" };
type Subs = TimerSub<Msg> | Sub<"feed", { on: true }>;
const makeModel = (count: number): Model => ({
  type: "state",
  count,
  timer: null,
});
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await sleep(1);
  }
  throw new Error("fixture condition did not settle");
}
function machine(feed: boolean) {
  const update: Reducer<Model, Msg, Cmd> = {
    add: (s, m) => [{ ...s, count: s.count + m.by }, []],
    work: (s) => [{ ...s, count: s.count + 10 }, [{ type: "work" }]],
    background: (s) => [s, [{ type: "background" }]],
    arm: (s, m) => [{ ...s, timer: m.ms }, []],
    tick: (s) => [{ ...s, count: s.count + 1, timer: null }, []],
  };
  return defineMachine({
    types: {
      model: {} as Model,
      msg: {} as Msg,
      cmd: {} as Cmd,
      sub: {} as Subs,
      ctx: {} as NoCtx,
    },
    init: (loaded) => [loaded ?? makeModel(0), []],
    update,
    subs: [
      {
        type: "timer",
        deps: (s) =>
          s.timer === null
            ? null
            : { ms: s.timer, msg: { type: "tick" } as const },
      },
      { type: "feed", deps: () => (feed ? { on: true as const } : null) },
    ],
  });
}
function start(seed: number, feed = false, loadFails = false) {
  const trace: unknown[][] = [];
  const reports: { name: string; phase: string }[] = [];
  const work = gate(),
    background = gate(),
    cleanup = gate();
  const fault = { code: 41 };
  let failSave = false;
  let stored = JSON.stringify(makeModel(seed));
  const store: Store<Model> = {
    async load() {
      trace.push(["load"]);
      await Promise.resolve();
      if (loadFails) throw fault;
      return stored;
    },
    migrate(raw) {
      trace.push(["migrate"]);
      return JSON.parse(String(raw)) as Model;
    },
    async save(state) {
      const wire = JSON.stringify(state);
      trace.push(["save", wire]);
      await Promise.resolve();
      if (failSave) {
        failSave = false;
        throw fault;
      }
      stored = wire;
    },
  };
  const runtime = run(machine(feed), {
    store,
    clock: () => 123,
    disposeTimeoutMs: 15,
    onError(error, context) {
      reports.push({
        name: error instanceof Error ? error.name : "raw",
        phase: context.phase,
      });
    },
    interpret: {
      work: async () => {
        trace.push(["work:start"]);
        await work.promise;
        trace.push(["work:end"]);
        return { type: "add", by: 3 };
      },
      background: async (_cmd, ctx, dispatch) => {
        trace.push(["background:start"]);
        detachWorkOf(ctx)(
          (async () => {
            await background.promise;
            trace.push(["background:end"]);
            dispatch?.({ type: "add", by: 4 });
          })(),
        );
      },
    },
    subscribe: {
      feed: () => {
        trace.push(["feed:start"]);
        return async () => {
          trace.push(["feed:cleanup:start"]);
          await cleanup.promise;
          trace.push(["feed:cleanup:end"]);
        };
      },
    },
  });
  const offListener = runtime.subscribe(() => trace.push(["listener"]));
  const offObserver = runtime.observe((msg, state) =>
    trace.push(["observe", msg.type, state.count]),
  );
  const offBoot = runtime.onBoot((state) => trace.push(["boot", state.count]));
  return {
    runtime,
    trace,
    reports,
    work,
    background,
    cleanup,
    fault,
    offListener,
    offObserver,
    offBoot,
    setFailSave: () => {
      failSave = true;
    },
    stored: () => stored,
  };
}
async function basic(seed: number) {
  const h = start(seed);
  const live = await h.runtime.ready;
  h.trace.push(["ready"]);
  await h.runtime.dispatch({ type: "add", by: 1 });
  h.trace.push(["receipt:add"]);
  const pending = h.runtime.dispatchOnce({ type: "work" });
  await until(() => h.trace.some((x) => x[0] === "work:start"));
  h.trace.push(["work:pending", live.getState().count]);
  h.work.release();
  await pending;
  h.trace.push(["receipt:work"]);
  await live.idle();
  await h.runtime.dispatchOnce({ type: "background" });
  h.trace.push(["receipt:background"]);
  h.background.release();
  await live.idle();
  await h.runtime.dispatch({ type: "arm", ms: 10000 });
  await h.runtime.dispatch({ type: "arm", ms: null });
  await h.runtime.dispatch({ type: "arm", ms: 4 });
  await until(() => live.getState().timer === null);
  await live.idle();
  h.offListener();
  h.offListener();
  h.offObserver();
  h.offBoot();
  await h.runtime.dispatch({ type: "add", by: 2 });
  await h.runtime.stop();
  h.trace.push(["stopped"]);
  return {
    trace: h.trace,
    reports: h.reports,
    model: live.getState(),
    stored: h.stored(),
  };
}
async function drain() {
  const h = start(2);
  const live = await h.runtime.ready;
  const pending = h.runtime.dispatchOnce({ type: "work" });
  await until(() => h.trace.some((x) => x[0] === "work:start"));
  const queued = h.runtime.dispatchOnce({ type: "add", by: 100 }).then(
    () => "folded",
    (error: unknown) => (error instanceof Error ? error.name : "raw"),
  );
  const began = Date.now();
  await h.runtime.stop();
  const elapsed = Date.now() - began;
  const atStop = h.stored();
  h.trace.push(["stopped"]);
  h.work.release();
  await pending;
  const queuedResult = await queued;
  await sleep(2);
  if (h.stored() !== atStop)
    throw new Error("late completion saved after stop");
  return {
    trace: h.trace,
    reports: h.reports,
    model: live.getState(),
    stored: h.stored(),
    queued: queuedResult,
    timeout_observed: elapsed >= 10,
  };
}
async function dispose() {
  const h = start(3, true);
  const live = await h.runtime.ready;
  const began = Date.now();
  await h.runtime.stop();
  const elapsed = Date.now() - began;
  h.trace.push(["stopped"]);
  h.cleanup.release();
  await until(() => h.trace.some((x) => x[0] === "feed:cleanup:end"));
  return {
    trace: h.trace,
    reports: h.reports,
    model: live.getState(),
    stored: h.stored(),
    timeout_observed: elapsed >= 10,
  };
}
async function saveFailure() {
  const h = start(5);
  const live = await h.runtime.ready;
  h.setFailSave();
  let original = false;
  try {
    await h.runtime.dispatchOnce({ type: "add", by: 2 });
  } catch (error) {
    original = error === h.fault;
  }
  h.trace.push(["save:error", original]);
  await h.runtime.stop();
  return {
    trace: h.trace,
    reports: h.reports,
    model: live.getState(),
    stored: h.stored(),
  };
}
async function loadFailure() {
  const h = start(5, false, true);
  let refused = "";
  try {
    await h.runtime.ready;
  } catch (error) {
    refused = error instanceof Error ? error.name : "raw";
  }
  await h.runtime.stop();
  return { trace: h.trace, reports: h.reports, refused, stored: h.stored() };
}
async function driven() {
  const h = start(0);
  const live = await h.runtime.ready;
  const result = await driveToDone(
    h.runtime,
    { type: "add", by: 9 },
    (state) => state.count === 9,
  );
  h.trace.push(["driven", result.count]);
  return {
    trace: h.trace,
    reports: h.reports,
    model: live.getState(),
    stored: h.stored(),
  };
}
export async function sourceFixture() {
  const [a, b] = await Promise.all([basic(7), basic(70)]);
  return {
    a,
    b,
    drain: await drain(),
    dispose: await dispose(),
    save_failure: await saveFailure(),
    load_failure: await loadFailure(),
    drive: await driven(),
  };
}
