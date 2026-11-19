/**
 * `boot: "restored"` (#964, ADR 0039): a run that boots from a saved State
 * runs none of `init`'s Cmds, and writes only when a transition commits.
 * Both engines run one loop, so every case runs on both. It lives under
 * `src/effect/` because it imports `effect`, which only this entry may do.
 */

import { Cause, Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineMachine,
  NoCellError,
  type Store,
  type Transitions,
} from "../index";
import { memoryJournal, memoryStore } from "../mem";
import { eventSourcedStore } from "../persistence";
import { run as runPromise } from "../promise";
import { run as runEffect } from "./index";

type Uploader =
  | { readonly _tag: "idle" }
  | { readonly _tag: "sending"; readonly files: number }
  | { readonly _tag: "done" };
type Msg =
  | { readonly _tag: "send"; readonly files: number }
  | { readonly _tag: "finish" };
type Cmd = { readonly _tag: "notify"; readonly text: string };

const idle: Uploader = { _tag: "idle" };
const sending: Uploader = { _tag: "sending", files: 2 };
const ready: Cmd = { _tag: "notify", text: "Uploader ready" };

const update: Transitions<Uploader, Msg, Cmd> = {
  idle: { send: (_s, m) => [{ _tag: "sending", files: m.files }, []] },
  sending: {
    finish: () => [
      { _tag: "done" },
      [{ _tag: "notify", text: "Uploader done" }],
    ],
  },
  done: {},
};

const uploader = defineMachine({
  types: { model: {} as Uploader, msg: {} as Msg, cmd: {} as Cmd },
  init: (loaded) => [loaded ?? idle, [ready]],
  update,
});

const ENGINES = ["Promise", "Effect"] as const;
type Engine = (typeof ENGINES)[number];

interface Started {
  /** The text of each `notify` that ran, in order. */
  readonly sent: string[];
  getState(): Uploader;
  dispatch(msg: Msg): Promise<void>;
  stop(): Promise<void>;
}
type Start = (
  machine: typeof uploader,
  store: Store<Uploader> | undefined,
  boot?: "restored",
) => Promise<Started>;

async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

const start: Record<Engine, Start> = {
  Promise: async (machine, store, boot) => {
    const sent: string[] = [];
    const rt = await runPromise(machine, {
      store,
      boot,
      onError: () => {},
      interpret: {
        notify: async (cmd) => {
          sent.push(cmd.text);
        },
      },
    }).ready;
    return {
      sent,
      getState: () => rt.getState(),
      dispatch: (msg) => rt.dispatch(msg),
      stop: () => rt.stop(),
    };
  },
  Effect: async (machine, store, boot) => {
    const sent: string[] = [];
    const scope = await Effect.runPromise(Scope.make());
    const rt = await settle(
      Scope.provide(scope)(
        Effect.flatMap(
          runEffect(machine, {
            store,
            boot,
            onError: () => {},
            interpret: {
              notify: (cmd) =>
                Effect.sync(() => {
                  sent.push(cmd.text);
                }),
            },
          }),
          (booting) => booting.ready,
        ),
      ),
    );
    return {
      sent,
      getState: () => rt.getState(),
      dispatch: (msg) => settle(rt.dispatch(msg)),
      stop: async () => {
        await settle(rt.stop());
        await Effect.runPromise(Scope.close(scope, Exit.void));
      },
    };
  },
};

/** A plain store over `seed` that records every load and every save. */
function counted(seed: Uploader | null) {
  const inner = memoryStore<Uploader>(seed);
  const calls = { loads: 0, saves: [] as Uploader[] };
  const store: Store<Uploader> = {
    async load() {
      calls.loads += 1;
      return inner.load();
    },
    async save(state) {
      calls.saves.push(state);
      await inner.save(state);
    },
    migrate: (raw) => inner.migrate(raw),
  };
  return { store, calls };
}

/** The fence's version after one accepted Msg on a store saved at version 1. */
async function versionAfterOneFinish(
  engine: Engine,
  boot: "restored" | undefined,
): Promise<number> {
  const fenced = memoryStore<Uploader>(null, undefined, { fenced: true });
  await fenced.saveFenced(sending, 0);
  const wake = await start[engine](uploader, fenced, boot);
  await wake.dispatch({ _tag: "finish" });
  await wake.stop();
  return (await fenced.loadFenced()).version;
}

describe.each(ENGINES)("%s engine: boot restored", (engine) => {
  it("a host that wakes ten times sends init's notice once, on the first start, and writes nothing on a wake", async () => {
    const { store, calls } = counted(null);
    const first = await start[engine](uploader, store);
    await first.stop();
    expect(first.sent).toEqual(["Uploader ready"]);
    const written = calls.saves.length;

    const heard: string[] = [];
    for (let wake = 1; wake <= 10; wake += 1) {
      const woken = await start[engine](uploader, store, "restored");
      heard.push(...woken.sent);
      await woken.stop();
    }
    expect(heard).toEqual([]);
    expect(calls.saves).toHaveLength(written);
    expect(calls.loads).toBe(11);
  });

  it("without `boot` a wake still runs init's Cmds and saves at boot and at stop", async () => {
    const { store, calls } = counted(sending);
    const wake = await start[engine](uploader, store);
    await wake.stop();
    expect(wake.sent).toEqual(["Uploader ready"]);
    expect(calls.saves).toEqual([sending, sending]);
  });

  it("a wake that takes a Msg saves once, for the transition, and still runs the transition's Cmds", async () => {
    const { store, calls } = counted(sending);
    const wake = await start[engine](uploader, store, "restored");
    await wake.dispatch({ _tag: "finish" });
    await wake.stop();
    expect(calls.saves).toEqual([{ _tag: "done" }]);
    expect(wake.sent).toEqual(["Uploader done"]);
  });

  it("a wake that takes a Msg its State has no cell for writes nothing and moves no fence", async () => {
    const fenced = memoryStore<Uploader>(null, undefined, { fenced: true });
    await fenced.saveFenced(sending, 0);
    const wake = await start[engine](uploader, fenced, "restored");
    await expect(
      wake.dispatch({ _tag: "send", files: 1 }),
    ).rejects.toBeInstanceOf(NoCellError);
    await wake.stop();
    expect(wake.sent).toEqual([]);
    expect(await fenced.loadFenced()).toEqual({ raw: sending, version: 1 });
  });

  it("moves a fenced version once for one accepted Msg, where the default moves it three times", async () => {
    expect(await versionAfterOneFinish(engine, undefined)).toBe(4);
    expect(await versionAfterOneFinish(engine, "restored")).toBe(2);
  });

  it("a start with nothing saved is a birth: init's Cmds run and its State is saved once", async () => {
    const { store, calls } = counted(null);
    const first = await start[engine](uploader, store, "restored");
    await first.stop();
    expect(first.sent).toEqual(["Uploader ready"]);
    expect(calls.saves).toEqual([idle]);
  });

  it("an init that returns another State than the loaded one has it saved, and still runs no Cmds", async () => {
    const migrating = {
      ...uploader,
      init: (loaded: Uploader | null): readonly [Uploader, readonly Cmd[]] =>
        loaded === null ? [idle, [ready]] : [{ _tag: "done" }, [ready]],
    };
    const { store, calls } = counted(sending);
    const wake = await start[engine](migrating, store, "restored");
    await wake.stop();
    expect(wake.sent).toEqual([]);
    expect(calls.saves).toEqual([{ _tag: "done" }]);
    expect(wake.getState()).toEqual({ _tag: "done" });
  });

  it("a run with no store is a first start whatever `boot` says", async () => {
    const first = await start[engine](uploader, undefined, "restored");
    await first.stop();
    expect(first.sent).toEqual(["Uploader ready"]);
  });
});

describe("boot restored on a log store", () => {
  it("changes nothing: a wake never calls init, with the option or without it", async () => {
    const inits: unknown[] = [];
    const counter = defineMachine({
      types: {
        model: {} as { readonly n: number },
        msg: {} as { readonly _tag: "go" },
      },
      init: (loaded) => {
        inits.push(loaded);
        return [loaded ?? { n: 0 }, []];
      },
      update: { go: (s) => [{ n: s.n + 1 }, []] },
    });
    const schemas = {
      state: z.object({ n: z.number() }),
      message: z.object({ _tag: z.literal("go") }),
      command: z.never(),
    };
    const journal = memoryJournal();
    const open = () => eventSourcedStore(journal, schemas);

    const first = await runPromise(counter, { store: open() }).ready;
    await first.dispatch({ _tag: "go" });
    await first.stop();
    for (const boot of [undefined, "restored"] as const) {
      const wake = await runPromise(counter, { store: open(), boot }).ready;
      expect(wake.getState()).toEqual({ n: 1 });
      await wake.stop();
    }
    expect(inits).toEqual([null]);
  });
});
