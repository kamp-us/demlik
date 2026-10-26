import { Cause, Effect, Exit, Scope } from "effect";
import { z } from "zod";
import { Stopped } from "../../packages/tea/src/effect/failures.ts";
import { run as runEffect } from "../../packages/tea/src/effect/index.ts";
import {
  type BootingRuntime,
  defineMachine,
  NoCellError,
  type Store,
  type Supervision,
  type Transitions,
} from "../../packages/tea/src/index.ts";
import { RuntimeStoppedError } from "../../packages/tea/src/internal/engine/loop.ts";
import { recorder } from "../../packages/tea/src/internal/persistence/recorder/index.ts";
import { run as runPromise } from "../../packages/tea/src/promise/index.ts";

export const actorInput = z
  .object({
    suite: z.literal("actor"),
    profile: z.enum(["promise", "effect"]),
    policy: z.enum(["stop", "escalate", "restart"]),
    scenario: z.enum([
      "declared",
      "nested-no-cell",
      "panic",
      "lookup",
      "identity-drop",
      "identity-panic",
      "success",
      "rehydrate-panic",
    ]),
    verb: z.enum(["dispatch", "once"]),
  })
  .strict();
type Input = z.infer<typeof actorInput>;
type Model = { type: "model"; n: number; original: object };
type Msg =
  | { type: "add"; by: number }
  | { type: "reject" }
  | { type: "unknown" };
type KnownMsg = Exclude<Msg, { type: "unknown" }>;
type Cmd = { type: "effect"; n: number };

export async function executeActor(input: Input) {
  const trace: string[] = [],
    saved: number[] = [],
    reports: unknown[] = [],
    raw: unknown[] = [],
    restarts: unknown[] = [];
  const original = { opaque: 73 },
    domain = { original };
  const nested = new NoCellError("child-missing", "child", ["child-ok"]);
  const panic = new Error("reducer boundary panic"),
    identityPanic = new Error("identity boundary panic"),
    rehydratePanic = new Error("rehydrate boundary panic");
  const reportErrors: unknown[] = [];
  let effects = 0;
  function kind(error: unknown): string {
    if (error === domain) return "declared";
    if (error === nested) return "nested-no-cell";
    if (error === panic || error === identityPanic || error === rehydratePanic)
      return "panic";
    if (error instanceof NoCellError) return "lookup";
    if (
      error &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "IdentityDropNotice"
    )
      return "identity-drop";
    if (error instanceof RuntimeStoppedError || error instanceof Stopped)
      return "stopped";
    throw error;
  }
  const store: Store<Model> = {
    async load() {
      trace.push("load");
      return null;
    },
    migrate() {
      trace.push("migrate");
      return null;
    },
    async save(s) {
      trace.push(`save:${s.n}`);
      saved.push(s.n);
    },
  };
  const add = (s: Model, m: Extract<Msg, { type: "add" }>) => {
    trace.push(`reduce:add:${s.n}`);
    const n = s.n + m.by;
    return [{ ...s, n }, [{ type: "effect", n }]] as const;
  };
  const reject = (s: Model): never => {
    trace.push(`reduce:reject:${s.n}`);
    throw input.scenario === "panic"
      ? panic
      : input.scenario === "nested-no-cell"
        ? nested
        : domain;
  };
  const update: Transitions<Model, KnownMsg, Cmd> = {
    model: input.scenario === "lookup" ? { add } : { add, reject },
  };
  const machine = defineMachine({
    types: {
      model: {} as Model,
      msg: {} as KnownMsg,
      cmd: {} as Cmd,
      ctx: undefined,
    },
    init: (): readonly [Model, readonly Cmd[]] => {
      trace.push("init:5");
      return [{ type: "model", n: 5, original }, []] as const;
    },
    update,
    subs: [
      {
        type: "timer",
        deps: (s: Model) => {
          trace.push(`subs:${s.n}`);
          return null;
        },
      },
    ],
    identity: {
      ofState: () => 1,
      ofMsg: (m: KnownMsg) => {
        if (m.type === "reject") {
          if (input.scenario === "identity-panic") throw identityPanic;
          if (input.scenario === "identity-drop") return 2;
        }
        return undefined;
      },
    },
  });
  const supervision: Supervision<Model, KnownMsg> =
    input.policy !== "restart"
      ? input.policy
      : {
          strategy: "restart",
          rehydrate: (s, m, error) => {
            trace.push(`rehydrate:${m.type}:${s.n}`);
            restarts.push({
              state: s.n,
              msg: m.type,
              kind: kind(error),
              sameReport: reportErrors.at(-1) === error,
            });
            if (input.scenario === "rehydrate-panic") throw rehydratePanic;
            return { ...s, n: 40 };
          },
        };
  const onError = (error: unknown, context: { phase: string }) => {
    const k = kind(error);
    trace.push(`report:${context.phase}:${k}`);
    reportErrors.push(error);
    reports.push({
      phase: context.phase,
      kind: k,
      sameOriginal: error === domain || error === nested ? true : null,
      saved: [...saved],
      effects,
    });
    raw.push({
      phase: context.phase,
      name:
        error && typeof error === "object" && "name" in error
          ? error.name
          : null,
    });
  };
  const scope = Effect.runSync(Scope.make());
  async function settled<A, E>(effect: Effect.Effect<A, E>) {
    const exit = await Effect.runPromiseExit(effect);
    if (Exit.isSuccess(exit)) return exit.value;
    raw.push({
      effectExit: Cause.hasFails(exit.cause) ? "typed-failure" : "defect",
    });
    throw Cause.squash(exit.cause);
  }
  let dispatch: (msg: KnownMsg) => Promise<void>,
    ready: () => Promise<void>,
    idle: () => Promise<void>,
    stop: () => Promise<void>,
    getState: () => Model = () => {
      throw new Error("not ready");
    };
  let boot: BootingRuntime<Model, KnownMsg>;
  const perform = (cmd: Cmd) => {
    trace.push(`effect:${cmd.n}`);
    effects++;
  };
  if (input.profile === "promise") {
    const live = runPromise(machine, {
      ctx: undefined,
      store,
      supervision,
      onError,
      interpret: {
        effect: async (cmd) => {
          perform(cmd);
        },
      },
    });
    boot = live;
    dispatch = (msg) =>
      input.verb === "once" ? live.dispatchOnce(msg) : live.dispatch(msg);
    ready = async () => {
      const rt = await live.ready;
      getState = () => rt.getState();
    };
    idle = () => live.ready.then((rt) => rt.idle());
    stop = () => live.stop();
  } else {
    const live = Effect.runSync(
      Scope.provide(scope)(
        runEffect(machine, {
          ctx: undefined,
          store,
          supervision,
          onError,
          interpret: { effect: (cmd) => Effect.sync(() => perform(cmd)) },
        }),
      ),
    );
    boot = live as unknown as BootingRuntime<Model, KnownMsg>;
    dispatch = (msg) =>
      settled(
        input.verb === "once" ? live.dispatchOnce(msg) : live.dispatch(msg),
      );
    ready = async () => {
      const rt = await settled(live.ready);
      getState = () => rt.getState();
    };
    idle = () => settled(live.ready).then((rt) => settled(rt.idle()));
    stop = () => Effect.runPromise(live.stop());
  }
  const record = recorder(boot, { captureSteps: true });
  const unboot = boot.onBoot((s) => trace.push(`boot:${s.n}`));
  const off = boot.observe((m, s) => trace.push(`observe:${m.type}:${s.n}`));
  try {
    await ready();
    trace.push("ready");
    const actions: Msg[] =
      input.scenario === "success"
        ? [
            { type: "add", by: 2 },
            { type: "add", by: 3 },
          ]
        : [
            { type: "add", by: 2 },
            input.scenario === "lookup"
              ? { type: "unknown" }
              : { type: "reject" },
            { type: "add", by: 3 },
          ];
    const receipts: unknown[] = [];
    let sameAfterTrigger: boolean | null = null;
    for (const [index, m] of actions.entries()) {
      const before = getState();
      try {
        await dispatch(m as KnownMsg);
        trace.push(`receipt:${m.type}:ok`);
        receipts.push({ msg: m.type, ok: true });
      } catch (error) {
        const k = kind(error);
        trace.push(`receipt:${m.type}:${k}`);
        receipts.push({
          msg: m.type,
          ok: false,
          kind: k,
          sameReport: reportErrors.includes(error),
        });
      }
      if (index === 1) sameAfterTrigger = before === getState();
    }
    await idle();
    const state = getState(),
      snapshot = record.dump();
    const captured = {
      anchor: snapshot.loaded?.n ?? null,
      msgs: snapshot.msgs.map((m) => m.type),
      states: snapshot.steps?.map((s) => s.state.n),
      final: snapshot.finalState.n,
      sameFinal: snapshot.finalState === state,
    };
    record.stop();
    off();
    unboot();
    await stop();
    trace.push("stopped");
    const stoppedSaved = [...saved];
    await stop();
    return {
      comparison: {
        trace,
        receipts,
        reports,
        restarts,
        n: state.n,
        owner: state.original === original,
        sameAfterTrigger,
        saved: stoppedSaved,
        effects,
        record: captured,
        stopIdempotent: JSON.stringify(saved) === JSON.stringify(stoppedSaved),
      },
      errorProfile: raw,
    };
  } finally {
    record.stop();
    off();
    unboot();
    await stop();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}
