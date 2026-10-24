import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { Cause, Effect, Exit, Scope } from "effect";
import { z } from "zod";
import { run as runEffect } from "../../packages/tea/src/effect/index.js";
import { defineMachine, type Store } from "../../packages/tea/src/index.js";
import { memoryStore } from "../../packages/tea/src/mem/index.js";
import { run as runPromise } from "../../packages/tea/src/promise/index.js";

const inputSchema = z.object({
  profile: z.enum(["promise", "effect"]),
  scenario: z.enum([
    "serial",
    "restored",
    "missing-handler",
    "handler-failure",
    "no-store",
    "terminal-boot",
    "held-save",
    "failed-save",
  ]),
});
type Input = z.infer<typeof inputSchema>;
type Model = { n: number; done: boolean };
type Msg =
  | { type: "Start" }
  | { type: "Added"; by: number }
  | { type: "Finish" };
type Command = { type: "Batch" } | { type: "Last" } | { type: "Fail" };
const boom = new Error("intentional handler failure");
const saveBoom = new Error("intentional save failure");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function failureOf(error: unknown): "handler" | "save" {
  if (error === boom) return "handler";
  if (
    error === saveBoom ||
    (typeof error === "object" &&
      error !== null &&
      "cause" in error &&
      error.cause === saveBoom)
  )
    return "save";
  throw error;
}

async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

async function execute(input: Input) {
  const trace: string[] = [];
  const reports: string[] = [];
  const entered = deferred();
  const released = deferred();
  let held = false;
  const controlsSave =
    input.scenario === "held-save" || input.scenario === "failed-save";
  const loaded: Model | null =
    input.scenario === "restored"
      ? { n: 5, done: false }
      : input.scenario === "terminal-boot"
        ? { n: 7, done: true }
        : null;
  const inner = memoryStore<Model>(loaded);
  const store: Store<Model> = {
    load: () => inner.load(),
    migrate: (raw) => inner.migrate(raw),
    async save(state) {
      trace.push(`save:${state.n}`);
      if (controlsSave && state.done && !held) {
        held = true;
        entered.resolve();
        await released.promise;
        if (input.scenario === "failed-save") throw saveBoom;
      }
      await inner.save(state);
    },
  };
  const machine = defineMachine({
    types: { model: {} as Model, msg: {} as Msg, cmd: {} as Command },
    init: (state) => [state ?? { n: 0, done: false }, []],
    update: {
      Start: (state) => [
        { n: state.n + 1, done: input.scenario === "handler-failure" },
        input.scenario === "handler-failure"
          ? [{ type: "Fail" }]
          : [{ type: "Batch" }, { type: "Last" }],
      ],
      Added: (state, message) => [{ ...state, n: state.n + message.by }, []],
      Finish: (state) => [{ ...state, done: true }, []],
    },
  });
  const shared = {
    store: input.scenario === "no-store" ? undefined : store,
    terminal: (state: Model) => state.done,
    onError: (_error: unknown, context: { phase: string }) =>
      reports.push(context.phase),
  };
  let dispatch: (message: Msg) => Promise<void>;
  let getState: () => Model;
  let result: () => Model | undefined;
  let done: () => Promise<Model>;
  let stop: () => Promise<void>;
  const committed = (message: Msg, state: Model) =>
    trace.push(`commit:${message.type}:${state.n}`);
  const booted = (state: Model) => trace.push(`commit:boot:${state.n}`);
  if (input.profile === "promise") {
    const handle = runPromise(machine, {
      ...shared,
      interpret: {
        Batch: async () => {
          if (input.scenario === "missing-handler") return undefined;
          trace.push("Batch");
          return [
            { type: "Added", by: 2 },
            { type: "Added", by: 4 },
          ] as const;
        },
        Last: async (_command, _context, emit) => {
          if (input.scenario === "missing-handler") return undefined;
          trace.push("Last");
          emit?.({ type: "Added", by: 8 });
          return { type: "Finish" } as const;
        },
        Fail: async () => {
          trace.push("Fail");
          throw boom;
        },
      },
    });
    handle.onBoot(booted);
    handle.observe(committed);
    const runtime = await handle.ready;
    dispatch = (message) => runtime.dispatch(message);
    getState = runtime.getState;
    result = runtime.result;
    done = runtime.done;
    stop = runtime.stop;
  } else {
    const scope = await Effect.runPromise(Scope.make());
    const handle = await Effect.runPromise(
      Scope.provide(scope)(
        runEffect(machine, {
          ...shared,
          interpret: {
            Batch: () =>
              Effect.sync(() => {
                if (input.scenario === "missing-handler") return undefined;
                trace.push("Batch");
                return [
                  { type: "Added", by: 2 },
                  { type: "Added", by: 4 },
                ] as const;
              }),
            Last: () =>
              Effect.sync(() => {
                if (input.scenario === "missing-handler") return undefined;
                trace.push("Last");
                return [{ type: "Added", by: 8 }, { type: "Finish" }] as const;
              }),
            Fail: () =>
              Effect.sync(() => {
                trace.push("Fail");
              }).pipe(Effect.andThen(Effect.fail(boom))),
          },
        }),
      ),
    );
    handle.onBoot(booted);
    handle.observe(committed);
    const runtime = await settle(handle.ready);
    dispatch = (message) => settle(runtime.dispatch(message));
    getState = runtime.getState;
    result = runtime.result;
    done = () => settle(runtime.done());
    stop = () => Effect.runPromise(Scope.close(scope, Exit.void));
  }
  let failure: string | null = null;
  let pendingSave: unknown = null;
  let doneFailure: string | null = null;
  let doneState: Model | null = null;
  if (input.scenario !== "terminal-boot") {
    const dispatched = dispatch(
      controlsSave ? { type: "Finish" } : { type: "Start" },
    ).then(() => null, failureOf);
    if (controlsSave) {
      await entered.promise;
      let doneStatus = "pending";
      const waiter = done().then(
        (state) => {
          doneStatus = "resolved";
          return { state, failure: null };
        },
        (error: unknown) => {
          doneStatus = "rejected";
          return { state: null, failure: failureOf(error) };
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      pendingSave = {
        state: getState(),
        result: result() ?? null,
        saved: await inner.load(),
        doneStatus,
        trace: [...trace],
      };
      released.resolve();
      failure = await dispatched;
      const settled = await waiter;
      doneFailure = settled.failure;
      doneState = settled.state;
      if (input.scenario === "failed-save") {
        await assert.rejects(done(), (error) => failureOf(error) === "save");
      }
    } else {
      failure = await dispatched;
    }
  }
  const terminal = result() ?? null;
  const completed = terminal === null ? null : await done();
  const output = {
    state: getState(),
    result: terminal,
    done: completed,
    pendingSave,
    doneFailure,
    doneState,
    saved: input.scenario === "no-store" ? null : await inner.load(),
    trace: [...trace],
    failure,
    reports: [...reports],
  };
  await stop();
  return {
    ...output,
    afterStop: {
      saved: input.scenario === "no-store" ? null : await inner.load(),
      trace: [...trace],
      reports: [...reports],
    },
  };
}

const requestSchema = z.object({ id: z.string(), input: inputSchema });
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  let id: string | null = null;
  try {
    const request = requestSchema.parse(JSON.parse(line));
    id = request.id;
    const output = await execute(request.input);
    process.stdout.write(`${JSON.stringify({ id, ok: true, output })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ id, ok: false, error: String(error) })}\n`,
    );
  }
}
