import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Cmd,
  defineMachine,
  type Reducer,
  replay,
  type Settled,
} from "../../index";
import { arbMsg, arbMsgSequence } from "../arbitraries";
import {
  PropertyFailure,
  propertyInvariant,
  propertyTerminates,
  propertyTrace,
} from "./property";
import { foldEvents } from "./replay-fold";

// A machine shaped like one a real reducer grows into: a defined Cmd in `cmds`,
// a hand-written Cmd beside it, and an `init` that sends a Cmd on each start.

const fetch = Cmd.define("fetch", {
  input: z.object({ url: z.string() }),
  ok: z.object({ body: z.string() }),
  err: ["timeout"],
});

type FetchCmd = ReturnType<typeof fetch>;
type PokeCmd = { readonly type: "poke" };
type SentCmd = FetchCmd | PokeCmd;
type State = { readonly type: "fresh" | "resumed"; readonly sends: number };
type Msg =
  | { readonly type: "send" }
  | { readonly type: "wait" }
  | Settled<typeof fetch>;

const SEEDS = [1, 42, 20261101];

// Declared here rather than taken from fast-check's types: 4 does not know
// `errorWithCause`, and this file's tests run on both majors.
const IN_CAUSE: { readonly errorWithCause?: boolean } = {
  errorWithCause: true,
};

const BOOT = fetch({ url: "boot" });
const RESUME = fetch({ url: "resume" });
const LOADED: State = { type: "resumed", sends: 3 };

const STRYKER = "Stryker was here";
const NOPE = { type: "nope" };

/** A value the Cmd type rules out, sent the way only a cast or a mutant can. */
const junk = (value: unknown) => value as SentCmd;

const update: Reducer<State, Msg, SentCmd> = {
  send: (s) => [{ ...s, sends: s.sends + 1 }, [fetch({ url: "next" })]],
  wait: (s) => [s, []],
  fetch_ok: (s) => [s, []],
  fetch_err: (s) => [s, []],
};

const sending = (
  sent: SentCmd,
  declared: "with cmds" | "no cmds" = "with cmds",
) => {
  const cells: Reducer<State, Msg, SentCmd> = {
    ...update,
    send: (s) => [{ ...s, sends: s.sends + 1 }, [sent]],
  };
  return declared === "with cmds"
    ? defineApp({ cells })
    : defineMachine({
        types: {
          model: {} as State,
          msg: {} as Msg,
          cmd: {} as SentCmd,
          ctx: {} as Record<string, never>,
        },
        init: bootInit([]),
        update: cells,
      });
};

function bootInit(initCmds: readonly SentCmd[]) {
  return (loaded: State | null) =>
    [loaded ?? { type: "fresh" as const, sends: 0 }, initCmds] as const;
}

function defineApp({
  cells = update,
  init = bootInit([]),
}: {
  readonly cells?: Reducer<State, Msg, SentCmd>;
  readonly init?: (
    loaded: State | null,
  ) => readonly [State, readonly SentCmd[]];
}) {
  return defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      cmd: {} as SentCmd,
      ctx: {} as Record<string, never>,
    },
    cmds: [fetch],
    init,
    update: cells,
  });
}

const msgArb = arbMsg<Msg>({
  send: fc.constant({ type: "send" as const }),
  wait: fc.constant({ type: "wait" as const }),
  fetch_ok: fc.constant(fetch.ok(BOOT, { body: "body" }, 0)),
  fetch_err: fc.constant(fetch.err(BOOT, { _tag: "timeout" }, 0)),
});

const seqArb = arbMsgSequence(msgArb, { minLength: 1, maxLength: 30 });

const failureOf = (act: () => unknown): PropertyFailure => {
  try {
    act();
  } catch (error) {
    expect(error).toBeInstanceOf(PropertyFailure);
    return error as PropertyFailure;
  }
  throw new Error("expected the property to fail, and it passed");
};

describe("a test author sees a junk Cmd fail", () => {
  const BROKEN = [
    [
      `a reducer sending ${JSON.stringify(STRYKER)}`,
      sending(junk(STRYKER)),
      false,
      JSON.stringify(STRYKER),
    ],
    [
      "a reducer sending an undeclared Cmd, strict",
      sending(junk(NOPE)),
      true,
      JSON.stringify(NOPE),
    ],
    [
      `an init sending ${JSON.stringify(STRYKER)}`,
      defineApp({ init: bootInit([junk(STRYKER)]) }),
      false,
      JSON.stringify(STRYKER),
    ],
    [
      "an init sending an undeclared Cmd, strict",
      defineApp({ init: bootInit([junk(NOPE)]) }),
      true,
      JSON.stringify(NOPE),
    ],
  ] as const;

  describe.each(BROKEN)("%s", (_name, machine, strict, named) => {
    it.each(SEEDS)("fails naming the Cmd, seed %i", (seed) => {
      const failure = failureOf(() =>
        propertyInvariant(machine, {}, seqArb, () => true, {
          seed,
          failOnUndeclaredCmd: strict,
        }),
      );
      expect(failure.message).toContain(named);
      expect(failure.run.seed).toBe(seed);
    });

    // Fast-check 4 files a throw in `cause` by default, so this setting is how
    // the fast-check 3 line CI installs reaches the arm 4's users depend on.
    it("names the Cmd when fast-check files the throw in cause", () => {
      const failure = failureOf(() =>
        propertyInvariant(machine, {}, seqArb, () => true, {
          seed: 1,
          failOnUndeclaredCmd: strict,
          ...IN_CAUSE,
        }),
      );
      expect(failure.cause).toBeInstanceOf(Error);
      expect(failure.message).toContain(named);
    });
  });

  it.each(SEEDS)("the unbroken machine passes, seed %i", (seed) => {
    const passed = propertyInvariant(
      defineApp({ init: bootInit([BOOT]) }),
      {},
      seqArb,
      () => true,
      { seed, failOnUndeclaredCmd: true },
    );
    expect(passed.numRuns).toBe(200);
  });

  it("names the junk even when the law would choke on it", () => {
    const failure = failureOf(() =>
      propertyInvariant(
        sending(junk(null)),
        {},
        seqArb,
        ({ cmds }) => cmds.every((cmd) => cmd.type !== "poke"),
        { seed: 1 },
      ),
    );
    expect(failure.message).toContain("null isn't a Cmd");
  });
});

describe("a check sees the Cmds init sent", () => {
  const app = defineApp({
    init: (loaded) => [
      loaded ?? { type: "fresh", sends: 0 },
      loaded === null ? [BOOT] : [RESUME, BOOT],
    ],
  });
  type Sent = readonly SentCmd[];

  const STARTS = [
    ["a fresh start", null, [BOOT]],
    ["a loaded state", LOADED, [RESUME, BOOT]],
  ] as const;

  const RUNNERS: readonly (readonly [
    string,
    (loaded: State | null, seen: (sent: Sent) => void) => unknown,
  ])[] = [
    [
      "propertyTerminates",
      (loaded, seen) =>
        propertyTerminates(
          app,
          {},
          seqArb,
          (_state, initCmds) => {
            seen(initCmds);
            return true;
          },
          { loaded },
        ),
    ],
    [
      "propertyInvariant",
      (loaded, seen) =>
        propertyInvariant(
          app,
          {},
          seqArb,
          (_step, initCmds) => {
            seen(initCmds);
            return true;
          },
          { loaded },
        ),
    ],
    [
      "propertyTrace",
      (loaded, seen) =>
        propertyTrace(
          app,
          {},
          seqArb,
          (_steps, _final, initCmds) => {
            seen(initCmds);
            return true;
          },
          { loaded },
        ),
    ],
  ];

  describe.each(RUNNERS)("%s", (_name, run) => {
    it.each(STARTS)("on %s", (_start, loaded, expected) => {
      const seen: Sent[] = [];
      run(loaded, (sent) => seen.push(sent));
      expect(seen.length).toBeGreaterThan(0);
      for (const sent of seen) expect(sent).toEqual(expected);
    });
  });

  it("a law can fail on them, over a drawn saved state", () => {
    const failure = failureOf(() =>
      propertyTrace(
        app,
        {},
        seqArb,
        (_steps, _final, initCmds) =>
          initCmds.length === 1 ? null : "a restart sent a second Cmd",
        { seed: 1, loaded: fc.constantFrom<State | null>(null, LOADED) },
      ),
    );
    expect(failure.message).toContain("a restart sent a second Cmd");
    expect(failure.message).toContain(JSON.stringify(LOADED));
  });

  describe.each(STARTS)("foldEvents, on %s", (_start, loaded, expected) => {
    const msgs: readonly Msg[] = [{ type: "send" }, { type: "wait" }];

    it("returns them, and no Step holds them", () => {
      const fold = foldEvents(app, {}, loaded, msgs);
      expect(fold.initCmds).toEqual(expected);
      expect(fold.steps.map((step) => step.cmds)).toEqual([
        [fetch({ url: "next" })],
        [],
      ]);
    });

    it("sends what replay sends, init's first", () => {
      const fold = foldEvents(app, {}, loaded, msgs);
      const sent = [...fold.initCmds, ...fold.steps.flatMap((s) => s.cmds)];
      expect(sent).toEqual(replay(app, { msgs, ctx: {}, loaded }).cmds);
    });
  });
});

describe("a value with no string type", () => {
  const VALUES = [
    ["a string", STRYKER],
    ["a number", 7],
    ["null", null],
    ["undefined", undefined],
    ["an array", []],
    ["an object with no type", {}],
    ["a type that isn't a string", { type: 7 }],
  ] as const;

  const DECLARED = ["with cmds", "no cmds"] as const;

  describe.each(DECLARED)("on a machine %s", (declared) => {
    it.each(VALUES)("fails on %s", (_name, value) => {
      const failure = failureOf(() =>
        propertyInvariant(
          sending(junk(value), declared),
          {},
          seqArb,
          () => true,
        ),
      );
      expect(failure.message).toContain(`${fc.stringify(value)} isn't a Cmd`);
    });
  });

  it("fails every runner, not only propertyInvariant", () => {
    const machine = sending(junk(STRYKER), "no cmds");
    for (const act of [
      () => propertyTerminates(machine, {}, seqArb, () => true),
      () => propertyTrace(machine, {}, seqArb, () => true),
    ]) {
      expect(failureOf(act).message).toContain(JSON.stringify(STRYKER));
    }
  });
});

describe("the strict option", () => {
  // `dispatchMachine`'s shape: `cmds: [fetch]`, and a hand-written `poke` beside it.
  const handWritten = sending({ type: "poke" });

  it("is off by default, so a hand-written Cmd passes", () => {
    const passed = propertyInvariant(handWritten, {}, seqArb, () => true);
    expect(passed.numRuns).toBe(200);
  });

  it("fails that Cmd when on, and names the list", () => {
    const failure = failureOf(() =>
      propertyInvariant(handWritten, {}, seqArb, () => true, {
        seed: 1,
        failOnUndeclaredCmd: true,
      }),
    );
    expect(failure.message).toContain(
      `${JSON.stringify({ type: "poke" })} isn't in machine.cmds: [fetch]`,
    );
  });

  it("adds nothing on a machine that declares no cmds", () => {
    const passed = propertyInvariant(
      sending(junk(NOPE), "no cmds"),
      {},
      seqArb,
      () => true,
      { failOnUndeclaredCmd: true },
    );
    expect(passed.numRuns).toBe(200);
  });
});
