/**
 * The Effect `drive` (#321) — the Promise `drive`'s rounds, trace and bound,
 * over the Effect engine's handlers, Layers and Subs.
 *
 * The claims under test: a cell settles here as it does under the Effect
 * engine's `run` (a Msg, a list, or nothing for a hand-written Cmd; `_ok` /
 * `_err` for a defined one); the services a cell or runner reads come from the
 * caller's Layer; the Subs the machine wants run and their Msgs fold; the
 * trace matches the Promise `drive`'s on the same machine; and every way the
 * drive can end is typed or dies the way the engine's would.
 */

import { Cause, Context, Effect, Exit, Layer, Option, Stream } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { Cmd, defineMachine, type Settled, type Sub } from "../../index";
import { drive as drivePromise } from "../promise";
import {
  DriveNoHandlerError,
  type DriveResult,
  DriveRoundsExceededError,
  type DriveTraceEntry,
  drive,
  driveTraceOf,
} from ".";

// --- a counting machine that settles ----------------------------------------

interface CountState {
  readonly left: number;
  readonly done: number;
}

type CountMsg =
  | { readonly type: "start"; readonly left: number }
  | { readonly type: "worked"; readonly label: string };

type WorkCmd = { readonly type: "work"; readonly label: string };

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

const working = {
  work: (cmd: WorkCmd) =>
    Effect.succeed({ type: "worked" as const, label: cmd.label }),
};

const idle: CountState = { left: 0, done: 0 };

const msgsOf = <M, C>(trace: readonly DriveTraceEntry<M, C>[]): readonly M[] =>
  trace.flatMap((entry) => (entry.kind === "msg" ? [entry.msg] : []));

/** Run a drive to its Exit, so a test reads a failure or a defect. */
const exitOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromiseExit(effect);

/** The typed failure an Exit ended with. */
function failureOf<E>(exit: Exit.Exit<unknown, E>): E {
  if (Exit.isSuccess(exit)) throw new Error("the drive settled");
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) throw new Error("the drive did not fail");
  return failure.value;
}

describe("drive (Effect)", () => {
  it("settles the machine and yields the state and the trace", async () => {
    const { state, trace } = await Effect.runPromise(
      drive(counting, idle, { type: "start", left: 2 }, working),
    );

    expect(state).toEqual({ left: 0, done: 2 });
    expect(trace).toEqual([
      { kind: "msg", msg: { type: "start", left: 2 } },
      { kind: "cmd", cmd: { type: "work", label: "w2" } },
      { kind: "msg", msg: { type: "worked", label: "w2" } },
      { kind: "cmd", cmd: { type: "work", label: "w1" } },
      { kind: "msg", msg: { type: "worked", label: "w1" } },
    ]);
  });

  it("traces the same history as the Promise drive on the same machine", async () => {
    const effect = await Effect.runPromise(
      drive(counting, idle, { type: "start", left: 3 }, working),
    );
    const promise = await drivePromise(
      counting,
      idle,
      { type: "start", left: 3 },
      {
        work: async (cmd: WorkCmd) => ({
          type: "worked" as const,
          label: cmd.label,
        }),
      },
    );

    expect(effect).toEqual(promise);
  });

  it("folds a hand-written cell's Msg list in order, and settles on nothing (#324)", async () => {
    type Msg =
      | { readonly type: "fire" }
      | { readonly type: "got"; readonly n: number };
    type Burst = { readonly type: "burst" } | { readonly type: "hush" };
    const burst = defineMachine({
      types: {
        model: {} as readonly number[],
        msg: {} as Msg,
        cmd: {} as Burst,
        ctx: undefined,
      },
      init: (loaded) => [loaded ?? [], []],
      update: {
        fire: (s) => [
          s,
          [{ type: "burst" as const }, { type: "hush" as const }],
        ],
        got: (s, m) => [[...s, m.n], []],
      },
    });

    const { state, trace } = await Effect.runPromise(
      drive(
        burst,
        [],
        { type: "fire" },
        {
          burst: () =>
            Effect.succeed([0, 1, 2].map((n) => ({ type: "got" as const, n }))),
          hush: () => Effect.void,
        },
      ),
    );

    expect(state).toEqual([0, 1, 2]);
    expect(msgsOf(trace).map((m) => m.type)).toEqual([
      "fire",
      "got",
      "got",
      "got",
    ]);
  });

  describe("a `Cmd.define`d Cmd", () => {
    const load = Cmd.define("load", {
      input: z.object({ id: z.string() }),
      ok: z.object({ name: z.string() }),
      err: ["missing"],
    });
    type Msg =
      | { readonly type: "go"; readonly id: string }
      | Settled<typeof load>;
    type Model = { readonly names: readonly string[]; readonly errs: number };
    const lookup = defineMachine({
      types: { model: {} as Model, msg: {} as Msg },
      cmds: [load],
      init: (loaded) => [loaded ?? { names: [], errs: 0 }, []],
      update: {
        go: (m, msg) => [m, [load({ id: msg.id })]],
        load_ok: (m, msg) => [
          { ...m, names: [...m.names, msg.value.name] },
          [],
        ],
        load_err: (m) => [{ ...m, errs: m.errs + 1 }, []],
      },
    });
    const start: Model = { names: [], errs: 0 };

    it("mints its success into `_ok`, stamped with the drive's clock", async () => {
      const { state, trace } = await Effect.runPromise(
        drive(
          lookup,
          start,
          { type: "go", id: "7" },
          { load: (cmd) => Effect.succeed({ name: `user ${cmd.id}` }) },
          { clock: () => 42 },
        ),
      );

      expect(state).toEqual({ names: ["user 7"], errs: 0 });
      expect(msgsOf(trace)[1]).toMatchObject({ type: "load_ok", at: 42 });
    });

    it("mints its declared failure into `_err`, and the drive still settles", async () => {
      const { state } = await Effect.runPromise(
        drive(
          lookup,
          start,
          { type: "go", id: "7" },
          { load: () => Effect.fail({ _tag: "missing" as const }) },
        ),
      );

      expect(state).toEqual({ names: [], errs: 1 });
    });

    it("gives its cell no `dispatch`, so it cannot send its own `_ok` (#304)", () => {
      drive(
        lookup,
        start,
        { type: "go", id: "7" },
        {
          // @ts-expect-error — an Effect cell takes the Cmd only; there is no
          // `dispatch` to send a self-built `load_ok` through
          load: (_cmd: unknown, dispatch: (msg: Msg) => void) =>
            Effect.sync(() => dispatch({ type: "go", id: "again" })),
        },
      );
    });

    it("dies on a defect, as the engine's error sink would get it", async () => {
      const exit = await exitOf(
        drive(
          lookup,
          start,
          { type: "go", id: "7" },
          { load: () => Effect.die(new Error("boom")) },
        ),
      );

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    });
  });

  describe("services from the caller's Layer", () => {
    class Directory extends Context.Service<
      Directory,
      { readonly nameOf: (id: string) => string }
    >()("Directory") {}
    class Pulse extends Context.Service<Pulse, { readonly beats: number }>()(
      "Pulse",
    ) {}

    type Beat = Sub<"beat", { readonly on: true }>;
    type Msg =
      | { readonly type: "go"; readonly id: string }
      | { readonly type: "named"; readonly name: string }
      | { readonly type: "beat" };
    type Model = { readonly names: readonly string[]; readonly beats: number };
    const named = defineMachine({
      types: {
        model: {} as Model,
        msg: {} as Msg,
        cmd: {} as { readonly type: "name"; readonly id: string },
        sub: {} as Beat,
        ctx: undefined,
      },
      init: (loaded) => [loaded ?? { names: [], beats: 0 }, []],
      update: {
        go: (m, msg) => [m, [{ type: "name" as const, id: msg.id }]],
        named: (m, msg) => [{ ...m, names: [...m.names, msg.name] }, []],
        beat: (m) => [{ ...m, beats: m.beats + 1 }, []],
      },
      subs: [{ type: "beat", deps: () => ({ on: true as const }) }],
    });

    const program = drive(
      named,
      { names: [], beats: 0 },
      { type: "go", id: "7" },
      {
        name: (cmd) =>
          Effect.gen(function* () {
            const directory = yield* Directory;
            return { type: "named" as const, name: directory.nameOf(cmd.id) };
          }),
      },
      {
        subscribe: {
          beat: () =>
            Stream.unwrap(
              Effect.gen(function* () {
                const pulse = yield* Pulse;
                return Stream.range(1, pulse.beats).pipe(
                  Stream.map(() => ({ type: "beat" as const })),
                );
              }),
            ),
        },
      },
    );

    it("types R as exactly the services the cells and runners read", () => {
      expectTypeOf(program).toEqualTypeOf<
        Effect.Effect<
          DriveResult<
            Model,
            Msg,
            { readonly type: "name"; readonly id: string }
          >,
          | DriveRoundsExceededError<
              Msg,
              { readonly type: "name"; readonly id: string }
            >
          | DriveNoHandlerError<
              Msg,
              { readonly type: "name"; readonly id: string }
            >,
          Directory | Pulse
        >
      >();
    });

    it("runs a cell and a Sub runner on the services a Layer provides", async () => {
      const layer = Layer.merge(
        Layer.succeed(Directory, { nameOf: (id) => `user ${id}` }),
        Layer.succeed(Pulse, { beats: 3 }),
      );

      const { state } = await Effect.runPromise(
        program.pipe(Effect.provide(layer)),
      );

      expect(state).toEqual({ names: ["user 7"], beats: 3 });
    });
  });

  describe("Subs", () => {
    type Tick = Sub<"ticks", { readonly until: number }>;
    type Msg =
      | { readonly type: "arm"; readonly until: number }
      | { readonly type: "tick" }
      | { readonly type: "later" };
    type Model = {
      readonly until: number | null;
      readonly ticks: number;
      readonly later: boolean;
    };
    const ticking = defineMachine({
      types: {
        model: {} as Model,
        msg: {} as Msg,
        sub: {} as Tick,
        ctx: undefined,
      },
      init: (loaded) => [loaded ?? { until: null, ticks: 0, later: false }, []],
      update: {
        arm: (m, msg) => [{ ...m, until: msg.until }, []],
        tick: (m) => {
          const ticks = m.ticks + 1;
          // The Sub is off once the count is reached.
          return [
            { ...m, ticks, until: ticks >= (m.until ?? 0) ? null : m.until },
            [],
          ];
        },
        later: (m) => [{ ...m, later: true }, []],
      },
      subs: [
        {
          type: "ticks",
          deps: (m) => (m.until === null ? null : { until: m.until }),
        },
        {
          type: "timer",
          deps: (m) =>
            m.ticks > 0 && !m.later
              ? { ms: 1, msg: { type: "later" as const } }
              : null,
        },
      ],
    });
    const start: Model = { until: null, ticks: 0, later: false };

    it("starts the Subs a fold turns on, folds their Msgs, and stops the ones it turns off", async () => {
      let stopped = false;
      const { state, trace } = await Effect.runPromise(
        drive(
          ticking,
          start,
          { type: "arm", until: 2 },
          {},
          {
            subscribe: {
              // Never ends on its own: only the fold that turns the Sub off
              // stops it, which is the reconcile under test.
              ticks: () =>
                Stream.make(
                  { type: "tick" as const },
                  { type: "tick" as const },
                ).pipe(
                  Stream.concat(Stream.never),
                  Stream.ensuring(
                    Effect.sync(() => {
                      stopped = true;
                    }),
                  ),
                ),
            },
          },
        ),
      );

      expect(stopped).toBe(true);
      expect(state).toEqual({ until: null, ticks: 2, later: true });
      expect(msgsOf(trace).map((m) => m.type)).toEqual([
        "arm",
        "tick",
        "tick",
        "later",
      ]);
    });

    it("runs a built-in Sub with the engine's own runner", async () => {
      const { state } = await Effect.runPromise(
        drive(
          ticking,
          { ...start, ticks: 1 },
          { type: "tick" },
          {},
          {
            subscribe: { ticks: () => Stream.empty },
          },
        ),
      );

      expect(state.later).toBe(true);
    });

    it("dies when a Sub's Stream fails with an error it did not map to a Msg", async () => {
      const exit = await exitOf(
        drive(
          ticking,
          start,
          { type: "arm", until: 2 },
          {},
          {
            subscribe: { ticks: () => Stream.fail("socket closed") },
          },
        ),
      );

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    });

    it("dies when a wanted Sub has no runner", async () => {
      const exit = await exitOf(
        drive(
          ticking,
          start,
          { type: "arm", until: 2 },
          {},
          // Cast: the typed map requires `ticks`; the runtime arm is under test.
          { subscribe: {} as { ticks: () => Stream.Stream<Msg> } },
        ),
      );

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    });
  });

  describe("how a drive fails", () => {
    it("fails with DriveRoundsExceededError, typed, instead of a half-driven state", async () => {
      const exit = await exitOf(
        drive(counting, idle, { type: "start", left: 10 }, working, {
          maxRounds: 3,
        }),
      );

      const err = failureOf(exit);
      expect(err).toBeInstanceOf(DriveRoundsExceededError);
      expect((err as DriveRoundsExceededError<CountMsg, WorkCmd>).rounds).toBe(
        4,
      );
    });

    it("fails with DriveNoHandlerError for a Cmd no cell answers", async () => {
      const exit = await exitOf(
        drive(
          counting,
          idle,
          { type: "start", left: 1 },
          {} as unknown as typeof working,
        ),
      );

      expect(failureOf(exit)).toBeInstanceOf(DriveNoHandlerError);
    });

    it("fails with a hand-written cell's own failure, typed, carrying the trace", async () => {
      class PortDown {
        readonly _tag = "PortDown" as const;
      }
      const program = drive(
        counting,
        idle,
        { type: "start", left: 3 },
        {
          work: () => Effect.fail(new PortDown()),
        },
      );
      expectTypeOf(program).toEqualTypeOf<
        Effect.Effect<
          DriveResult<CountState, CountMsg, WorkCmd>,
          | DriveRoundsExceededError<CountMsg, WorkCmd>
          | DriveNoHandlerError<CountMsg, WorkCmd>
          | PortDown,
          never
        >
      >();

      const err = failureOf(await exitOf(program));

      expect(err).toBeInstanceOf(PortDown);
      expect(driveTraceOf(err)).toEqual([
        { kind: "msg", msg: { type: "start", left: 3 } },
        { kind: "cmd", cmd: { type: "work", label: "w3" } },
      ]);
    });

    it("interrupts the cell in flight when the drive is interrupted", async () => {
      let interrupted = false;
      const exit = await exitOf(
        drive(
          counting,
          idle,
          { type: "start", left: 1 },
          {
            work: () =>
              Effect.never.pipe(
                Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    interrupted = true;
                  }),
                ),
              ),
          },
        ).pipe(Effect.timeout("10 millis")),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(interrupted).toBe(true);
    });
  });
});
