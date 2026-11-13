/**
 * A machine that lists two Cmds under one name is refused, on both engines
 * (#927; invariant 7: nothing is silent).
 *
 * The fixture is the realistic one: twenty Cmds, eighteen with names of their
 * own and two built by one helper that defaults its name to `fetch_file`, with
 * different `ok` schemas, so the author never writes both names. It is refused
 * twice over: when the machine is built (`defineMachine` / `Machine.make`) and,
 * for a machine that never went through either, when `run` or `drive` starts it.
 */

import { Cause, Effect, Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AnyCmdDef,
  CmdNameCollisionError,
  Cmd as CoreCmd,
  type Machine as CoreMachine,
  defineMachine,
  type Sub,
} from "../index";
import { run as runPromise } from "../promise";
import { drive as driveEffect } from "../testing/effect";
import { drive as drivePromise } from "../testing/promise";
import { Cmd, Machine, run as runEffect } from ".";

type State = { readonly asked: number };
type Msg = { readonly type: "go" };
type Poke = { readonly type: "poke" };

const initial: State = { asked: 0 };
const go: Msg = { type: "go" };

/** Eighteen Cmds that each have a name of their own. */
const ownNames = Array.from(
  { length: 18 },
  (_, i) => `step_${String(i + 1).padStart(2, "0")}`,
);

type Kind = "bytes" | "text";

/** What an engine's author writes: Cmd defs, a machine, and a way to start it. */
type Flavor = {
  /** The helper that defaults its name to `fetch_file`. */
  readonly fetchFile: (kind: Kind, name?: string) => AnyCmdDef;
  /** The engine's maker, over a `cmds` list the maker does not type-check. */
  readonly build: (cmds: readonly AnyCmdDef[]) => unknown;
  readonly start: Record<
    "run" | "drive",
    (machine: Plain, calls: string[]) => Promise<void>
  >;
};

/** A machine written as a plain object: it never passes through a maker. */
type Plain = CoreMachine<State, Msg, Poke, Sub<never>, undefined>;

const plain = (cmds: readonly AnyCmdDef[]): Plain => ({
  init: () => [initial, []],
  update: {
    go: (s) => [{ asked: s.asked + 1 }, [{ type: "poke" }]],
  },
  cmds,
});

/** An Effect refusal is a defect: rethrow what it died with. */
const refusal = (exit: Exit.Failure<unknown, unknown>): never => {
  throw Cause.squash(exit.cause);
};

const flavors = {
  promise: {
    fetchFile: (kind, name = "fetch_file") =>
      kind === "bytes"
        ? CoreCmd.define(name, {
            input: z.object({ path: z.string() }),
            ok: z.object({ bytes: z.number() }),
            err: ["offline"],
          })
        : CoreCmd.define(name, {
            input: z.object({ path: z.string() }),
            ok: z.object({ text: z.string() }),
            err: ["offline"],
          }),
    build: (cmds) =>
      defineMachine({
        types: { model: {} as State, msg: {} as Msg, ctx: undefined },
        cmds,
        init: () => [initial, []],
        update: { go: (s) => [s, []] },
      }),
    start: {
      run: async (machine, calls) => {
        const rt = await runPromise(machine, {
          ctx: undefined,
          interpret: { poke: async () => void calls.push("poke") },
        }).ready;
        await rt.dispatch(go);
        await rt.idle();
        await rt.stop();
      },
      drive: async (machine, calls) => {
        await drivePromise(machine, initial, go, {
          poke: async () => void calls.push("poke"),
        });
      },
    },
  },
  effect: {
    fetchFile: (kind, name = "fetch_file") =>
      kind === "bytes"
        ? Cmd.make(name, {
            input: Schema.Struct({ path: Schema.String }),
            ok: Schema.Struct({ bytes: Schema.Number }),
            err: ["offline"],
          })
        : Cmd.make(name, {
            input: Schema.Struct({ path: Schema.String }),
            ok: Schema.Struct({ text: Schema.String }),
            err: ["offline"],
          }),
    build: (cmds) =>
      Machine.make({
        model: Schema.Struct({ asked: Schema.Number }),
        msg: Schema.Struct({ type: Schema.Literal("go") }),
        cmds,
        init: () => [initial, []],
        update: { go: (s) => [s, []] },
      }),
    start: {
      run: async (machine, calls) => {
        const exit = await Effect.runPromiseExit(
          Effect.scoped(
            Effect.gen(function* () {
              const booting = yield* runEffect(machine, {
                ctx: undefined,
                interpret: {
                  poke: () => Effect.sync(() => void calls.push("poke")),
                },
              });
              const rt = yield* booting.ready;
              yield* rt.dispatch(go);
              yield* rt.idle();
            }),
          ),
        );
        if (Exit.isFailure(exit)) refusal(exit);
      },
      drive: async (machine, calls) => {
        const exit = await Effect.runPromiseExit(
          driveEffect(machine, initial, go, {
            poke: () => Effect.sync(() => void calls.push("poke")),
          }),
        );
        if (Exit.isFailure(exit)) refusal(exit);
      },
    },
  },
} satisfies Record<string, Flavor>;

/** Twenty Cmds, with the two built by the helper spread apart in the list. */
const twenty = (flavor: Flavor, second: string): readonly AnyCmdDef[] => [
  ...ownNames.slice(0, 9).map((name) => flavor.fetchFile("bytes", name)),
  flavor.fetchFile("bytes"),
  ...ownNames.slice(9).map((name) => flavor.fetchFile("bytes", name)),
  flavor.fetchFile("text", second),
];

/** Twenty Cmds, one def listed twice. */
const sameDefTwice = (flavor: Flavor): readonly AnyCmdDef[] => {
  const fetchFile = flavor.fetchFile("bytes");
  return [
    ...ownNames.slice(0, 9).map((name) => flavor.fetchFile("bytes", name)),
    fetchFile,
    ...ownNames.slice(9).map((name) => flavor.fetchFile("bytes", name)),
    fetchFile,
  ];
};

const listings = {
  "two Cmds built by one helper": (flavor: Flavor) =>
    twenty(flavor, "fetch_file"),
  "one def listed twice": sameDefTwice,
} as const;

/** The error `thunk` throws; fails the test when it throws nothing. */
function thrownBy(thunk: () => unknown): unknown {
  try {
    thunk();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

function expectNamesFetchFile(error: unknown): void {
  expect(error).toBeInstanceOf(CmdNameCollisionError);
  const { cmdType, message } = error as CmdNameCollisionError;
  expect(cmdType).toBe("fetch_file");
  expect(message).toContain("fetch_file");
  for (const name of ownNames) expect(message).not.toContain(name);
}

describe.each(Object.entries(flavors))("on the %s engine", (_, flavor) => {
  describe.each(Object.entries(listings))("%s", (_, listing) => {
    it("is refused when the machine is built, every time", () => {
      expectNamesFetchFile(thrownBy(() => flavor.build(listing(flavor))));
      expectNamesFetchFile(thrownBy(() => flavor.build(listing(flavor))));
    });

    it.each([
      "run",
      "drive",
    ] as const)("is refused by `%s` when a plain machine starts, before any handler is called", async (how) => {
      const calls: string[] = [];
      const error = await flavor.start[how](plain(listing(flavor)), calls).then(
        () => undefined,
        (refused: unknown) => refused,
      );
      expectNamesFetchFile(error);
      expect(calls).toEqual([]);
    });
  });

  describe("a machine whose Cmds all have distinct names", () => {
    const distinct = twenty(flavor, "fetch_text");

    it("builds", () => {
      expect(() => flavor.build(distinct)).not.toThrow();
    });

    it.each([
      "run",
      "drive",
    ] as const)("starts under `%s` and calls its handler", async (how) => {
      const calls: string[] = [];
      await flavor.start[how](plain(distinct), calls);
      expect(calls).toEqual(["poke"]);
    });
  });
});
