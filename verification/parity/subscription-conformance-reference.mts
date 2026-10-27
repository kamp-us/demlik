import { createInterface } from "node:readline";
import { Cause, Effect, Exit, Queue, Scope, Stream } from "effect";
import { z } from "zod";
import {
  Stopped,
  StoreFailed,
} from "../../packages/tea/src/effect/failures.ts";
import { run as runEffect } from "../../packages/tea/src/effect/index.ts";
import {
  defineMachine,
  refuse,
  type Store,
  StoreRefusedError,
  type Sub,
} from "../../packages/tea/src/index.ts";
import { RuntimeStoppedError } from "../../packages/tea/src/internal/engine/loop.ts";
import { run as runPromise } from "../../packages/tea/src/promise/index.ts";
import { subscriptionScenarios } from "./subscription-conformance-cases.mjs";

const inputSchema = z
  .object({
    profile: z.enum(["promise", "effect"]),
    scenario: z.enum(subscriptionScenarios as [string, ...string[]]),
    policy: z.enum(["stop", "escalate", "restart"]),
    origin: z.enum(["caller", "producer"]),
    verb: z.enum(["dispatch", "once"]),
  })
  .strict();
const request = z.object({ id: z.string(), input: inputSchema }).strict();
type Input = z.infer<typeof inputSchema>;
type Model = { type: "model"; n: number; original: object };
type Msg = { type: "set"; n: number };
type Cmd = { type: "effect"; n: number };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
const turn = () => new Promise<void>((r) => setImmediate(r));
async function waitFor(f: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (f()) return;
    await turn();
  }
  throw new Error("fixture gate did not enter");
}
export async function executeSubscription(input: Input) {
  const { scenario, profile } = input;
  const trace: string[] = [],
    saved: number[] = [],
    reports: unknown[] = [],
    receipts: unknown[] = [],
    snapshots: unknown[] = [],
    errorProfile: unknown[] = [];
  const original = { opaque: 73 },
    first = { kind: "projection:first", original },
    second = { kind: "projection:second", original },
    runnerError = { kind: "runner", original },
    cleanupError = { kind: "cleanup", original },
    loadError = new Error("load broke"),
    saveError = new Error("save broke");
  const projectionAtOne = [
    "recover",
    "two-failures",
    "mixed-runner",
    "mixed-cleanup",
    "mixed-all",
    "held-save-projection",
  ].includes(scenario);
  const initialN = ["boot-projection", "stored-projection"].includes(scenario)
    ? 1
    : scenario === "stored" || scenario.startsWith("held-load")
      ? 4
      : 0;
  const loaded: Model = { type: "model", n: initialN, original };
  let cell: Model | null = [
    "stored",
    "stored-projection",
    "held-load",
    "held-load-dispatch",
  ].includes(scenario)
    ? loaded
    : null;
  let current: Model | undefined,
    saveCount = 0,
    loadEntered = false,
    saveEntered = false,
    cleanupEntered = false;
  const loadGate = gate(),
    saveGate = gate(),
    cleanupGate = gate();
  const active = new Set<string>();
  let emit: ((n: number) => void) | undefined;
  let reduceCount = 0,
    restarts = 0,
    effects = 0,
    commits = 0,
    bootCallbacks = 0;
  const reportErrors: unknown[] = [];
  function unwrapped(error: unknown): unknown {
    return error instanceof StoreFailed ? error.cause : error;
  }
  function kind(error: unknown): string {
    error = unwrapped(error);
    if (error === first) return first.kind;
    if (error === second) return second.kind;
    if (error === runnerError) return "runner";
    if (error === cleanupError) return "cleanup";
    if (error === saveError) return "save";
    if (error instanceof StoreRefusedError) return "restore";
    const name = (error as { name?: string })?.name;
    if (error instanceof Stopped)
      return error.when === "stopping" ? "discarded" : "stopped";
    if (error instanceof RuntimeStoppedError) return "stopped";
    if (name === "DispatchDiscardedError") return "discarded";
    if (name === "DrainTimeoutNotice") return "drain-timeout";
    if (name === "DisposeTimeoutNotice") return "dispose-timeout";
    throw error;
  }
  function detail(error: unknown) {
    const k = kind(error);
    const boundary = error;
    error = unwrapped(error);
    const e = error as { reason?: string; cause?: unknown; name?: string };
    errorProfile.push({
      kind: k,
      name: e?.name ?? null,
      raw: JSON.parse(JSON.stringify(boundary)),
      boundaryName: (boundary as { name?: string })?.name ?? null,
    });
    return {
      kind: k,
      sameOriginal: k.startsWith("projection:")
        ? error === first || error === second
        : k === "runner"
          ? error === runnerError
          : k === "cleanup"
            ? error === cleanupError
            : null,
      ...(k === "restore"
        ? { reason: e.reason, loadCause: e.cause === loadError }
        : {}),
    };
  }
  const store: Store<Model> = {
    async load() {
      trace.push("load");
      loadEntered = true;
      if (scenario.startsWith("held-load")) await loadGate.promise;
      if (scenario === "load-failure") throw loadError;
      return cell;
    },
    migrate(raw) {
      trace.push("migrate");
      if (scenario === "migrate-refusal") return refuse("fixture refused");
      if (scenario === "migrate-throw") throw new Error("migration broke");
      return raw as Model | null;
    },
    async save(s) {
      saveCount++;
      const ordinal = saveCount;
      trace.push(`save:${s.n}:begin`);
      if (
        ["held-save", "held-save-projection"].includes(scenario) &&
        ordinal === 2
      ) {
        saveEntered = true;
        await saveGate.promise;
      }
      if (
        (scenario === "boot-save-failure" && ordinal === 1) ||
        (scenario === "step-save-failure" && ordinal === 2)
      )
        throw saveError;
      cell = s;
      saved.push(s.n);
      trace.push(`save:${s.n}:end`);
    },
  };
  const entry = (type: string) => ({
    type,
    deps: (s: Model) => {
      trace.push(`project:${type}:${s.n}`);
      if (
        type === "fragile" &&
        s.n === 1 &&
        (projectionAtOne ||
          ["boot-projection", "stored-projection"].includes(scenario))
      )
        throw first;
      if (type === "second" && s.n === 1 && scenario === "two-failures")
        throw second;
      if (type === "obsolete" && s.n !== 0) return null;
      if (type === "fragile" && s.n === 3) return null;
      return { n: type === "signal" ? 0 : s.n };
    },
  });
  const machine = defineMachine({
    types: {
      model: {} as Model,
      msg: {} as Msg,
      cmd: {} as Cmd,
      sub: {} as Sub<string, { n: number }>,
      ctx: undefined,
    },
    init: (state: Model | null): readonly [Model, readonly Cmd[]] => {
      current = state ?? { type: "model", n: initialN, original };
      trace.push(`init:${current.n}:${state === null ? "fresh" : "loaded"}`);
      return [current, [{ type: "effect", n: current.n }]];
    },
    update: {
      model: {
        set: (s: Model, m: Msg) => {
          reduceCount++;
          trace.push(`reduce:${s.n}->${m.n}`);
          current = { ...s, n: m.n };
          return [current, [{ type: "effect", n: m.n }]] as const;
        },
      },
    },
    subs: ["fragile", "second", "steady", "obsolete", "signal"].map(entry),
  });
  const onError = (error: unknown, context: { phase: string }) => {
    const d = detail(error);
    trace.push(`report:${context.phase}:${d.kind}`);
    reportErrors.push(error);
    reports.push({ phase: context.phase, ...d, saved: [...saved], effects });
  };
  function started(type: string, n: number) {
    const key = `${type}:${n}`;
    trace.push(`start:${key}`);
    if (
      type === "steady" &&
      n === 1 &&
      ["mixed-runner", "mixed-all"].includes(scenario)
    )
      throw runnerError;
    active.add(key);
    return key;
  }
  async function cleanup(key: string) {
    trace.push(`cleanup:${key}:begin`);
    active.delete(key);
    if (key === "obsolete:0" && scenario === "held-cleanup") {
      cleanupEntered = true;
      await cleanupGate.promise;
    }
    trace.push(`cleanup:${key}:end`);
    if (
      key === "obsolete:0" &&
      ["mixed-cleanup", "mixed-all"].includes(scenario)
    )
      throw cleanupError;
  }
  const scope = Effect.runSync(Scope.make());
  async function settled<A, E>(effect: Effect.Effect<A, E>) {
    const exit = await Effect.runPromiseExit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    errorProfile.push({
      effectExit: Cause.hasFails(exit.cause) ? "typed-failure" : "defect",
    });
    throw Cause.squash(exit.cause);
  }
  let ready: () => Promise<void>,
    dispatch: (n: number) => Promise<void>,
    idle: () => Promise<void>,
    stop: () => Promise<void>,
    getState: () => Model | undefined = () => current;
  const shared = {
    ctx: undefined,
    ...(scenario === "storeless" ? {} : { store }),
    onError,
    supervision:
      input.policy === "restart"
        ? {
            strategy: "restart" as const,
            rehydrate: (s: Model) => {
              restarts++;
              trace.push("rehydrate");
              return s;
            },
          }
        : input.policy,
    disposeTimeoutMs: scenario.startsWith("held-") ? 0 : 1000,
  };
  let hook: {
    onBoot: (f: (s: Model) => void) => () => void;
    observe: (f: (m: Msg, s: Model) => void) => () => void;
  };
  if (profile === "promise") {
    const subscribe = Object.fromEntries(
      ["fragile", "second", "steady", "obsolete", "signal"].map((type) => [
        type,
        (
          sub: { deps: { n: number } },
          _ctx: unknown,
          dispatch: (m: Msg) => void,
        ) => {
          const key = started(type, sub.deps.n);
          if (type === "signal") emit = (n) => dispatch({ type: "set", n });
          return () => cleanup(key);
        },
      ]),
    );
    const live = runPromise(machine, {
      ...shared,
      interpret: {
        effect: async (cmd: Cmd) => {
          effects++;
          trace.push(`effect:${cmd.n}`);
        },
      },
      subscribe,
    });
    hook = live;
    ready = async () => {
      const rt = await live.ready;
      getState = () => rt.getState();
    };
    dispatch = (n) =>
      input.verb === "once"
        ? live.dispatchOnce({ type: "set", n })
        : live.dispatch({ type: "set", n });
    idle = async () => {
      try {
        const rt = await live.ready;
        await rt.idle();
      } catch {}
    };
    stop = () => live.stop();
  } else {
    const subscribe = Object.fromEntries(
      ["fragile", "second", "steady", "obsolete", "signal"].map((type) => [
        type,
        (sub: { deps: { n: number } }) => {
          const key = started(type, sub.deps.n);
          return Stream.callback<Msg>((queue) =>
            Effect.gen(function* () {
              if (type === "signal")
                emit = (n) => {
                  Queue.offerUnsafe(queue, { type: "set", n });
                };
              yield* Effect.addFinalizer(() =>
                Effect.promise(() => cleanup(key)).pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() => {
                      errorProfile.push({
                        finalizer: key,
                        exit: Exit.isSuccess(exit) ? "success" : "failure",
                        sameOriginal: Exit.isFailure(exit)
                          ? Cause.squash(exit.cause) === cleanupError
                          : null,
                      });
                    }),
                  ),
                ),
              );
            }),
          );
        },
      ]),
    );
    const live = Effect.runSync(
      Scope.provide(scope)(
        runEffect(machine, {
          ...shared,
          interpret: {
            effect: (cmd: Cmd) =>
              Effect.sync(() => {
                effects++;
                trace.push(`effect:${cmd.n}`);
              }),
          },
          subscribe,
        }),
      ),
    );
    hook = live;
    ready = async () => {
      const rt = await settled(live.ready);
      getState = () => rt.getState();
    };
    dispatch = (n) =>
      settled(
        input.verb === "once"
          ? live.dispatchOnce({ type: "set", n })
          : live.dispatch({ type: "set", n }),
      );
    idle = async () => {
      try {
        const rt = await settled(live.ready);
        await settled(rt.idle());
      } catch {}
    };
    stop = () => Effect.runPromise(live.stop());
  }
  const offBoot = hook.onBoot((s) => {
    bootCallbacks++;
    trace.push(`boot:${s.n}`);
  });
  const off = hook.observe((m, s) => {
    commits++;
    trace.push(`observe:${m.n}:${s.n}`);
  });
  function snap(label: string) {
    const s = getState();
    snapshots.push({
      label,
      n: s?.n ?? null,
      loadedSame: s === loaded,
      original: s?.original === original,
      active: [...active].sort(),
      saved: [...saved],
      effects,
      commits,
      bootCallbacks,
    });
  }
  let cached: unknown, cachedBoundary: unknown;
  async function receipt(label: string, run: () => Promise<void>) {
    try {
      await run();
      trace.push(`receipt:${label}:ok`);
      receipts.push({ label, ok: true });
    } catch (error) {
      const d = detail(error);
      trace.push(`receipt:${label}:${d.kind}`);
      receipts.push({
        label,
        ok: false,
        ...d,
        sameCached: cached === undefined ? null : unwrapped(error) === cached,
        sameReport: reportErrors.includes(unwrapped(error)),
      });
      errorProfile.push({
        label,
        sameCachedBoundary:
          cachedBoundary === undefined ? null : cachedBoundary === error,
      });
      if (label === "ready") {
        cached = unwrapped(error);
        cachedBoundary = error;
      }
    }
  }
  try {
    if (scenario.startsWith("held-load")) {
      await waitFor(() => loadEntered);
      snap("load-held");
      let pending: Promise<void> | undefined;
      if (scenario === "held-load-dispatch")
        pending = receipt("queued", () => dispatch(9));
      await turn();
      await stop();
      trace.push("stopped-held");
      snap("after-stop");
      loadGate.release();
      await receipt("ready", ready);
      if (pending) await pending;
      snap("late-boot");
      await receipt("after-stop", () => dispatch(9));
    } else {
      await receipt("ready", ready);
      snap("boot");
      if (cached !== undefined) {
        await receipt("ready-again", ready);
        await receipt("cached-dispatch", () => dispatch(2));
        if (emit) {
          emit(2);
          await idle();
          await turn();
        }
      } else if (["held-save", "held-save-projection"].includes(scenario)) {
        const pending = receipt("held", () => dispatch(1));
        await waitFor(() => saveEntered);
        snap("save-held");
        await stop();
        trace.push("stopped-held");
        snap("after-stop");
        saveGate.release();
        await pending;
        snap("late-save");
      } else {
        const actions = [
          "recover",
          "two-failures",
          "mixed-runner",
          "mixed-cleanup",
          "mixed-all",
          "step-save-failure",
          "held-cleanup",
        ].includes(scenario)
          ? [1, 2, 3]
          : [2];
        for (const n of actions) {
          if (input.origin === "producer") {
            if (!emit) throw new Error("missing fixture producer");
            emit(n);
            await idle();
            await turn();
            trace.push(`receipt:producer:${n}`);
            receipts.push({ label: `producer:${n}`, ok: true });
          } else await receipt(`set:${n}`, () => dispatch(n));
          await turn();
          snap(`set:${n}`);
        }
      }
    }
    await stop();
    trace.push("stopped");
    if (scenario === "held-cleanup") {
      cleanupGate.release();
      await waitFor(
        () => !cleanupEntered || trace.includes("cleanup:obsolete:0:end"),
      );
    }
    await turn();
    snap("final");
    const finalSaved = [...saved];
    await stop();
    return {
      comparison: {
        trace,
        receipts,
        reports,
        snapshots,
        saved,
        effects,
        commits,
        bootCallbacks,
        reduceCount,
        restarts,
        stopIdempotent: JSON.stringify(saved) === JSON.stringify(finalSaved),
      },
      errorProfile,
    };
  } finally {
    loadGate.release();
    saveGate.release();
    cleanupGate.release();
    off();
    offBoot();
    await stop();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  const parsed = request.safeParse(JSON.parse(line));
  if (!parsed.success) {
    console.log(
      JSON.stringify({ id: null, ok: false, error: { kind: "protocol" } }),
    );
    continue;
  }
  console.log(
    JSON.stringify({
      id: parsed.data.id,
      ok: true,
      output: await executeSubscription(parsed.data.input),
    }),
  );
}
