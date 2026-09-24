/**
 * `drive` (#232) — the runtime's Cmd→handler→settle-Msg loop as one call.
 *
 * The claims under test are the ones a hand-rolled copy of this loop gets
 * subtly wrong: that the trace is the real history (replaying its Msgs
 * reproduces the state), that a Cmd-free fold never awaits anything, that an
 * unsettling machine THROWS rather than returning half-driven, and that a
 * rejecting handler's own error is what leaves `drive`.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { burst, burstAnswer } from "../../__fixtures__/engine-conformance";
import {
  Cmd,
  defineMachine,
  type Interpret,
  OutcomeContractError,
  replay,
  type Settled,
} from "../../index";
import { cmdEdgeOf } from "../../pure/core";
import {
  DEFAULT_MAX_ROUNDS,
  DriveNoHandlerError,
  DriveRoundsExceededError,
  type DriveTraceEntry,
  drive,
  driveTraceOf,
} from ".";

// --- a counting machine that settles ----------------------------------------
//
// `start` emits one `work` Cmd; the handler settles it as `worked`, which
// emits another `work` while the budget lasts. So a run is N rounds deep and
// its trace interleaves Msgs and Cmds in a shape a test can read.

interface CountState {
  readonly left: number;
  readonly done: number;
}

type CountMsg =
  | { readonly type: "start"; readonly left: number }
  | { readonly type: "worked"; readonly label: string };

type WorkCmd = Cmd<"work"> & { readonly label: string };

const counting = defineMachine({
  types: {
    model: {} as CountState,
    msg: {} as CountMsg,
    cmd: {} as WorkCmd,
    ctx: undefined,
  },
  init: (loaded) => [loaded ?? { left: 0, done: 0 }, []],
  update: {
    start: (_s, m) => [
      { left: m.left, done: 0 },
      m.left > 0 ? [{ type: "work" as const, label: `w${m.left}` }] : [],
    ],
    worked: (s) => {
      const left = s.left - 1;
      return [
        { left, done: s.done + 1 },
        left > 0 ? [{ type: "work" as const, label: `w${left}` }] : [],
      ];
    },
  },
});

/** The real handler record, as a test hands it to `drive`. */
const handlers = {
  work: async (cmd: WorkCmd) => ({
    type: "worked" as const,
    label: cmd.label,
  }),
};

const initial: CountState = { left: 0, done: 0 };

const msgsOf = <M, C>(trace: readonly DriveTraceEntry<M, C>[]): readonly M[] =>
  trace.flatMap((entry) => (entry.kind === "msg" ? [entry.msg] : []));

const cmdsOf = <M, C>(trace: readonly DriveTraceEntry<M, C>[]): readonly C[] =>
  trace.flatMap((entry) => (entry.kind === "cmd" ? [entry.cmd] : []));

describe("drive", () => {
  it("settles the machine and returns the state the runtime would have", async () => {
    const { state } = await drive(
      counting,
      initial,
      { type: "start", left: 3 },
      handlers,
    );

    expect(state).toEqual({ left: 0, done: 3 });
  });

  it("traces every Cmd dispatched and every settle Msg folded, in order", async () => {
    const { trace } = await drive(
      counting,
      initial,
      { type: "start", left: 2 },
      handlers,
    );

    expect(trace).toEqual([
      { kind: "msg", msg: { type: "start", left: 2 } },
      { kind: "cmd", cmd: { type: "work", label: "w2" } },
      { kind: "msg", msg: { type: "worked", label: "w2" } },
      { kind: "cmd", cmd: { type: "work", label: "w1" } },
      { kind: "msg", msg: { type: "worked", label: "w1" } },
    ]);
  });

  it("replays its own trace's Msgs to the state it returned", async () => {
    const { state, trace } = await drive(
      counting,
      initial,
      { type: "start", left: 4 },
      handlers,
    );

    const replayed = replay(counting, {
      msgs: msgsOf(trace),
      ctx: undefined,
      loaded: initial,
    });

    expect(replayed.state).toEqual(state);
  });

  it("settles in one round and awaits nothing when the first fold emits no Cmd", async () => {
    let awaited = 0;
    const counted = {
      work: async (cmd: WorkCmd) => {
        awaited += 1;
        return { type: "worked" as const, label: cmd.label };
      },
    };

    const { state, trace } = await drive(
      counting,
      initial,
      { type: "start", left: 0 },
      counted,
    );

    expect(awaited).toBe(0);
    expect(cmdsOf(trace)).toEqual([]);
    expect(trace).toEqual([{ kind: "msg", msg: { type: "start", left: 0 } }]);
    expect(state).toEqual({ left: 0, done: 0 });
  });

  it("folds a Msg a handler fires through its injected dispatch", async () => {
    const detached = {
      work: async (
        cmd: WorkCmd,
        _ctx: unknown,
        dispatch?: (msg: CountMsg) => void,
      ) => {
        dispatch?.({ type: "worked", label: cmd.label });
      },
    };

    const { state, trace } = await drive(
      counting,
      initial,
      { type: "start", left: 2 },
      detached,
    );

    expect(state).toEqual({ left: 0, done: 2 });
    expect(msgsOf(trace)).toHaveLength(3);
  });

  it("folds a returned list of Msgs in order, as `run` does (#324)", async () => {
    const { state, trace } = await drive(
      burst,
      { log: [] },
      { type: "fire" },
      {
        burst: async (cmd) => burstAnswer(cmd.count),
        hush: async () => [],
        last: async () => ({ type: "done" }),
      },
    );

    expect(state).toEqual({ log: ["got 0", "got 1", "got 2", "done"] });
    expect(msgsOf(trace).map((m) => m.type)).toEqual([
      "fire",
      "got",
      "got",
      "got",
      "done",
    ]);
  });

  it("hands each handler the ctx the caller supplied", async () => {
    interface Marked {
      readonly mark: string;
    }
    const marked = defineMachine({
      types: {
        model: {} as { readonly seen: string | null },
        msg: {} as
          | { readonly type: "go" }
          | { readonly type: "saw"; readonly mark: string },
        cmd: {} as Cmd<"peek">,
        ctx: {} as Marked,
      },
      init: (loaded) => [loaded ?? { seen: null }, []],
      update: {
        go: (s) => [s, [{ type: "peek" as const }]],
        saw: (_s, m) => [{ seen: m.mark }, []],
      },
    });

    const { state } = await drive(
      marked,
      { seen: null },
      { type: "go" },
      {
        peek: async (_cmd: Cmd<"peek">, ctx: Marked) => ({
          type: "saw" as const,
          mark: ctx.mark,
        }),
      },
      { ctx: { mark: "from-ctx" } },
    );

    expect(state).toEqual({ seen: "from-ctx" });
  });

  it("gives a handler a no-op emit so a port-emitting handler runs unwired", async () => {
    let emitted = false;
    const emitting = {
      work: async (cmd: WorkCmd, ctx: { emit: (...args: never[]) => void }) => {
        // biome-ignore lint/suspicious/noExplicitAny: the port is irrelevant here; what is under test is that `emit` EXISTS
        (ctx.emit as any)({ id: "noop" }, 1);
        emitted = true;
        return { type: "worked" as const, label: cmd.label };
      },
    };

    const { state } = await drive(
      counting,
      initial,
      { type: "start", left: 1 },
      emitting,
    );

    expect(emitted).toBe(true);
    expect(state).toEqual({ left: 0, done: 1 });
  });

  describe("maxRounds", () => {
    it("throws a named, instanceof-checkable error instead of a half-driven state", async () => {
      const failure = await drive(
        counting,
        initial,
        { type: "start", left: 10 },
        handlers,
        { maxRounds: 3 },
      ).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(DriveRoundsExceededError);
      expect(failure).toBeInstanceOf(Error);
      const err = failure as DriveRoundsExceededError<CountMsg, WorkCmd>;
      expect(err.name).toBe("DriveRoundsExceededError");
      expect(err._tag).toBe("DriveRoundsExceededError");
      expect(err.maxRounds).toBe(3);
      expect(err.rounds).toBe(4);
      expect(err.message).toMatch(/did not settle within 3 round/);
    });

    it("carries the partial trace up to the round it gave up on", async () => {
      const err = (await drive(
        counting,
        initial,
        { type: "start", left: 10 },
        handlers,
        { maxRounds: 2 },
      ).catch((e: unknown) => e)) as DriveRoundsExceededError<
        CountMsg,
        WorkCmd
      >;

      expect(msgsOf(err.trace)).toEqual([
        { type: "start", left: 10 },
        { type: "worked", label: "w10" },
      ]);
      expect(cmdsOf(err.trace)).toEqual([
        { type: "work", label: "w10" },
        { type: "work", label: "w9" },
      ]);
    });

    it("defaults to DEFAULT_MAX_ROUNDS when no bound is given", async () => {
      expect(DEFAULT_MAX_ROUNDS).toBe(100);

      const err = (await drive(
        counting,
        initial,
        { type: "start", left: 500 },
        handlers,
      ).catch((e: unknown) => e)) as DriveRoundsExceededError<
        CountMsg,
        WorkCmd
      >;

      expect(err).toBeInstanceOf(DriveRoundsExceededError);
      expect(err.maxRounds).toBe(DEFAULT_MAX_ROUNDS);
    });

    it("settles a run that fits exactly inside the bound", async () => {
      const { state } = await drive(
        counting,
        initial,
        { type: "start", left: 2 },
        handlers,
        { maxRounds: 3 },
      );

      expect(state).toEqual({ left: 0, done: 2 });
    });
  });

  describe("a rejecting handler", () => {
    class PortDown extends Error {
      override readonly name = "PortDown";
      readonly _tag = "PortDown" as const;
    }

    const rejecting = {
      work: async (): Promise<never> => {
        throw new PortDown("the fake port is down");
      },
    };

    it("propagates the handler's own error unswallowed", async () => {
      const failure = await drive(
        counting,
        initial,
        { type: "start", left: 3 },
        rejecting,
      ).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(PortDown);
      expect((failure as PortDown)._tag).toBe("PortDown");
      expect(failure).not.toBeInstanceOf(DriveRoundsExceededError);
    });

    it("leaves the trace up to the rejecting Cmd recoverable off the error", async () => {
      const failure = await drive(
        counting,
        initial,
        { type: "start", left: 3 },
        rejecting,
      ).catch((err: unknown) => err);

      const trace = driveTraceOf<CountMsg, WorkCmd>(failure);
      expect(trace).toEqual([
        { kind: "msg", msg: { type: "start", left: 3 } },
        { kind: "cmd", cmd: { type: "work", label: "w3" } },
      ]);
    });

    it("leaves no pending work — nothing settles after the rejection", async () => {
      let calls = 0;
      const once = {
        work: async (): Promise<never> => {
          calls += 1;
          throw new PortDown("down");
        },
      };

      await drive(counting, initial, { type: "start", left: 5 }, once).catch(
        () => {},
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(calls).toBe(1);
    });

    it("reads back undefined for an error drive never annotated", () => {
      expect(driveTraceOf(new Error("unrelated"))).toBeUndefined();
      expect(driveTraceOf("not an object")).toBeUndefined();
      expect(driveTraceOf(null)).toBeUndefined();
    });
  });

  it("refuses a Cmd no handler answers", async () => {
    const empty = {} as unknown as typeof handlers;

    const failure = await drive(
      counting,
      initial,
      { type: "start", left: 1 },
      empty,
    ).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DriveNoHandlerError);
    expect((failure as DriveNoHandlerError<CountMsg, WorkCmd>).cmdType).toBe(
      "work",
    );
  });
});

// --- the dispatch half of the `Cmd.define` contract (#304) ------------------
//
// The Promise engine refuses a defined Cmd's handler dispatching a `_ok` /
// `_err` it built itself (ADR 0021, #302). `drive` holds a handler to the same
// rule, so a test cannot go green on a program `run` rejects.

describe("drive and a defined handler's own dispatch (#304)", () => {
  const fetch = Cmd.define("fetch", {
    input: z.object({ url: z.string() }),
    ok: z.object({ body: z.string() }),
    err: ["timeout"],
  });

  type FetchCmd = ReturnType<typeof fetch>;
  type PokeCmd = { readonly type: "poke" };
  type DMsg =
    | { readonly type: "go"; readonly url: string }
    | { readonly type: "kick" }
    | { readonly type: "progress"; readonly note: string }
    | { readonly type: "poke_ok" }
    | Settled<typeof fetch>;

  interface Seen {
    readonly seen: readonly string[];
    readonly body: string | null;
  }

  const note = (s: Seen, type: string): Seen => ({
    ...s,
    seen: [...s.seen, type],
  });

  const dispatching = defineMachine({
    types: {
      model: {} as Seen,
      msg: {} as DMsg,
      cmd: {} as FetchCmd | PokeCmd,
      ctx: undefined,
    },
    cmds: [fetch],
    init: (loaded) => [loaded ?? { seen: [], body: null }, []],
    update: {
      go: (s, m) => [note(s, m.type), [fetch({ url: m.url })]],
      kick: (s, m) => [note(s, m.type), [{ type: "poke" as const }]],
      progress: (s, m) => [note(s, m.type), []],
      poke_ok: (s, m) => [note(s, m.type), []],
      fetch_ok: (s, m) => [{ ...note(s, m.type), body: m.value.body }, []],
      fetch_err: (s, m) => [note(s, m.type), []],
    },
  });

  type Handlers = Interpret<DMsg, FetchCmd | PokeCmd, undefined>;
  const noPoke: Handlers["poke"] = async () => undefined;
  const start: Seen = { seen: [], body: null };

  it.each([
    ["fetch_ok", (cmd: FetchCmd) => fetch.ok(cmd, { body: "self-minted" })],
    ["fetch_err", (cmd: FetchCmd) => fetch.err(cmd, { _tag: "timeout" })],
  ] as const)("throws OutcomeContractError when a defined handler dispatches its own `%s`", async (own, mintOwn) => {
    const handlers: Handlers = {
      fetch: async (cmd, _ctx, dispatch) => {
        dispatch?.(mintOwn(cmd));
      },
      poke: noPoke,
    };

    const failure = await drive(
      dispatching,
      start,
      { type: "go", url: "/a" },
      handlers,
    ).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(OutcomeContractError);
    expect(failure).toMatchObject({ cmdType: "fetch" });
    expect((failure as Error).message).toContain(
      `dispatched its own "${own}" Msg`,
    );
    expect(driveTraceOf(failure)).toEqual([
      { kind: "msg", msg: { type: "go", url: "/a" } },
      { kind: "cmd", cmd: { type: "fetch", url: "/a" } },
    ]);
  });

  it("refuses it even when the handler catches what its dispatch threw", async () => {
    const handlers: Handlers = {
      fetch: async (cmd, _ctx, dispatch) => {
        try {
          dispatch?.(fetch.ok(cmd, { body: "self-minted" }));
        } catch {
          // Swallowing it here must not smuggle the violation past drive.
        }
      },
      poke: noPoke,
    };

    await expect(
      drive(dispatching, start, { type: "go", url: "/a" }, handlers),
    ).rejects.toBeInstanceOf(OutcomeContractError);
  });

  it("passes a settle the engine's edge minted, dispatched through `cmdEdgeOf(ctx)`", async () => {
    const handlers: Handlers = {
      fetch: async (cmd, ctx, dispatch) => {
        dispatch?.(
          cmdEdgeOf(ctx)(cmd, ctx.ok({ body: "via edge" })) as Settled<
            typeof fetch
          >,
        );
      },
      poke: noPoke,
    };

    const { state } = await drive(
      dispatching,
      start,
      { type: "go", url: "/a" },
      handlers,
      { clock: () => 5 },
    );

    expect(state).toEqual({ seen: ["go", "fetch_ok"], body: "via edge" });
  });

  it("passes a defined handler's other Msgs", async () => {
    const handlers: Handlers = {
      fetch: async (_cmd, { ok }, dispatch) => {
        dispatch?.({ type: "progress", note: "half way" });
        return ok({ body: "done" });
      },
      poke: noPoke,
    };

    const { state } = await drive(
      dispatching,
      start,
      { type: "go", url: "/a" },
      handlers,
    );

    expect(state).toEqual({
      seen: ["go", "progress", "fetch_ok"],
      body: "done",
    });
  });

  it("lets a hand-written Cmd's handler dispatch any Msg, `_ok`-named or not", async () => {
    const handlers: Handlers = {
      fetch: async (_cmd, { ok }) => ok({ body: "unused" }),
      poke: async (_cmd, _ctx, dispatch) => {
        dispatch?.({ type: "poke_ok" });
        dispatch?.({ type: "progress", note: "poked" });
      },
    };

    const { state } = await drive(
      dispatching,
      start,
      { type: "kick" },
      handlers,
    );

    expect(state.seen).toEqual(["kick", "poke_ok", "progress"]);
  });
});
