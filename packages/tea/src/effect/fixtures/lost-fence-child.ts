/**
 * The child program behind `../../lost-fence.test.ts` (#728). Bundled and spawned
 * by that test; nothing imports it.
 *
 * `host` runs three fenced runs in one process and passes the `onError` the type
 * requires. `takeover` is the second process, taking one of those runs over.
 * `failing-sub` is an unfenced run whose Sub fails, with or without a sink.
 * `widened-host` starts three fenced runs through a helper typed plain `Store`,
 * with no `onError`, which each engine refuses at start (#810).
 */

import { join } from "node:path";
import { Cause, Effect, Exit, Scope, Stream } from "effect";
import { z } from "zod";
import {
  defineMachine,
  type RuntimeErrorContext,
  type Store,
  type Sub,
} from "../../index";
import { fileStore } from "../../node";
import { run as runPromise } from "../../promise";
import { run as runEffect } from "../index";

const [engine, mode, dir] = z
  .tuple([
    z.enum(["promise", "effect"]),
    z.enum([
      "host",
      "takeover",
      "failing-sub",
      "failing-sub-with-sink",
      "widened-host",
    ]),
    z.string().min(1),
  ])
  .parse(process.argv.slice(2));

const model = z.object({ count: z.number().int().nonnegative() });
type Model = z.infer<typeof model>;
type Msg = { readonly type: "bump" };
type Poke = Sub<"poke", Record<string, never>>;

const machine = defineMachine({
  types: {
    model: {} as Model,
    msg: {} as Msg,
    sub: {} as Poke,
    ctx: undefined,
  },
  init: (loaded) => [loaded ?? { count: 0 }, []],
  update: { bump: (state) => [{ count: state.count + 1 }, []] },
  subs: [{ type: "poke", deps: () => ({}) }],
});

const bumpMsg: Msg = { type: "bump" };
const fileOf = (name: string) => join(dir, `${name}.json`);
const storeOf = (name: string) =>
  fileStore(fileOf(name), (raw) => (raw === null ? null : model.parse(raw)), {
    fenced: true,
  });

type OnReport = (error: unknown, context: RuntimeErrorContext) => void;

/** One run, the same shape on either engine. */
interface Host {
  readonly bump: () => Promise<string>;
  readonly count: () => number;
  /** Deliver a bump the way a Sub does: no caller is there to reject at. */
  readonly poke: () => void;
  readonly stop: () => Promise<void>;
}

/** What a failed dispatch says, on either engine. */
function outcomeOf(error: unknown): string {
  const { _tag, cause, name } = error as {
    readonly _tag?: string;
    readonly cause?: { readonly _tag?: string };
    readonly name?: string;
  };
  return cause?._tag ?? _tag ?? name ?? "unknown";
}

function deferred(): { readonly at: Promise<void>; readonly fire: () => void } {
  let fire!: () => void;
  const at = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { at, fire };
}

async function openOnPromise(name: string, onError: OnReport): Promise<Host> {
  const poked = deferred();
  const rt = await runPromise(machine, {
    ctx: undefined,
    store: storeOf(name),
    onError,
    subscribe: {
      poke: (_sub, _ctx, dispatch) => {
        void poked.at.then(() => dispatch(bumpMsg));
        return () => {};
      },
    },
  }).ready;
  return {
    bump: () =>
      rt.dispatch(bumpMsg).then(
        () => "ok",
        (error) => outcomeOf(error),
      ),
    count: () => rt.getState().count,
    poke: poked.fire,
    stop: () => rt.stop(),
  };
}

async function openOnEffect(name: string, onError: OnReport): Promise<Host> {
  const poked = deferred();
  const scope = await Effect.runPromise(Scope.make());
  const rt = await Effect.runPromise(
    Effect.flatMap(
      runEffect(machine, {
        ctx: undefined,
        store: storeOf(name),
        onError,
        subscribe: {
          poke: () =>
            Stream.fromEffect(
              Effect.promise(() => poked.at).pipe(Effect.as(bumpMsg)),
            ),
        },
      }),
      (booting) => booting.ready,
    ).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  return {
    bump: async () => {
      const exit = await Effect.runPromiseExit(rt.dispatch(bumpMsg));
      return Exit.isSuccess(exit) ? "ok" : outcomeOf(Cause.squash(exit.cause));
    },
    count: () => rt.getState().count,
    poke: poked.fire,
    stop: () => Effect.runPromise(rt.stop()),
  };
}

const open = engine === "promise" ? openOnPromise : openOnEffect;

/** A later macrotask: a rethrow from the default sink lands before it. */
const aLaterTurn = () => new Promise((resolve) => setTimeout(resolve, 50));

/** Three fenced runs; `b` gets taken over while `a` and `c` keep going. */
async function host(): Promise<void> {
  const reports: { readonly phase: string; readonly error: string }[] = [];
  const onError: OnReport = (error, context) => {
    reports.push({ phase: context.phase, error: outcomeOf(error) });
  };
  const a = await open("a", onError);
  const b = await open("b", onError);
  const c = await open("c", onError);
  await Promise.all([a.bump(), b.bump(), c.bump()]);

  const taken = deferred();
  process.once("message", taken.fire);
  process.send?.({ type: "ready" });
  await taken.at;

  const others = [a, c];
  const bumpOthers = () => Promise.all(others.map((run) => run.bump()));
  const before = await bumpOthers();

  // A lost fence with no caller to reject at, the takeover a host has not yet
  // noticed. Wait for the sink to hear it.
  b.poke();
  while (!reports.some((report) => report.phase === "follow-up")) {
    await aLaterTurn();
  }
  const msgBeforeStop = await b.bump();
  await b.stop();
  const msgAfterStop = await b.bump();

  const after = await bumpOthers();
  await aLaterTurn();

  process.send?.({
    type: "result",
    before,
    after,
    msgBeforeStop,
    msgAfterStop,
    reports,
    counts: { a: a.count(), c: c.count() },
  });
  await Promise.all(others.map((run) => run.stop()));
  process.disconnect();
}

/** The second process: boot on `b`, which takes its fence, and write. */
async function takeover(): Promise<void> {
  const b = await open("b", () => {});
  await b.bump();
  await b.stop();
}

/**
 * An unfenced run whose Sub fails. With no sink the process is expected to die
 * before the `alive` below is sent, from the sink alone: the Effect program's
 * own failure is read here, so it cannot be what ended it.
 */
async function failingSub(onError: OnReport | undefined): Promise<void> {
  const failure = new Error("the sub failed");
  if (engine === "promise") {
    // The boot that started the Sub rejects too, and is read here for the same
    // reason.
    await runPromise(machine, {
      ctx: undefined,
      onError,
      subscribe: {
        poke: () => {
          throw failure;
        },
      },
    }).ready.catch(() => {});
  } else {
    await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runEffect(machine, {
            ctx: undefined,
            onError,
            subscribe: { poke: () => Stream.fail(failure) },
          });
          yield* Effect.sleep(50);
        }),
      ),
    );
  }
  await aLaterTurn();
  await aLaterTurn();
  process.send?.({ type: "alive" });
  process.disconnect();
}

/** A host helper that hands back a fenced store under the plain type. */
const widenedStoreOf = (name: string): Store<Model> => storeOf(name);

/** What starting one widened run came to: refused, or a run left open. */
type Widened =
  | { readonly refused: string }
  | { readonly refused?: undefined; readonly stop: () => Promise<unknown> };

/**
 * Start one run on `widenedStoreOf(name)` with no `onError`, as the type allows,
 * and bump it once. A run the engine lets start is left open, so a takeover can
 * reach its final save.
 */
async function startWidened(name: string): Promise<Widened> {
  if (engine === "promise") {
    try {
      const rt = await runPromise(machine, {
        ctx: undefined,
        store: widenedStoreOf(name),
        subscribe: { poke: () => () => {} },
      }).ready;
      await rt.dispatch(bumpMsg);
      return { stop: () => rt.stop() };
    } catch (error) {
      return { refused: (error as Error).message };
    }
  }
  const scope = await Effect.runPromise(Scope.make());
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const booting = yield* runEffect(machine, {
        ctx: undefined,
        store: widenedStoreOf(name),
        subscribe: { poke: () => Stream.never },
      });
      const rt = yield* booting.ready;
      yield* rt.dispatch(bumpMsg);
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  if (Exit.isSuccess(exit)) {
    return { stop: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
  }
  return { refused: (Cause.squash(exit.cause) as Error).message };
}

/**
 * Three widened runs. Each should be refused; one that started anyway is
 * stopped after the takeover of `b`, where its final save meets the lost fence.
 */
async function widenedHost(): Promise<void> {
  const runs = [
    await startWidened("a"),
    await startWidened("b"),
    await startWidened("c"),
  ];
  const taken = deferred();
  process.once("message", taken.fire);
  process.send?.({
    type: "refused",
    refusals: runs.map((run) => run.refused ?? "started"),
  });
  await taken.at;
  for (const run of runs) if (run.refused === undefined) await run.stop();
  await aLaterTurn();
  process.send?.({ type: "alive" });
  process.disconnect();
}

if (mode === "host") await host();
else if (mode === "widened-host") await widenedHost();
else if (mode === "takeover") await takeover();
else if (mode === "failing-sub") await failingSub(undefined);
else
  await failingSub((error, context) => {
    process.send?.({
      type: "heard",
      phase: context.phase,
      message: (error as Error).message,
    });
  });
