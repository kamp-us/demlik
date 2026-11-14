import * as fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AnyCmdDef,
  Cmd,
  CmdNameCollisionError,
  defineMachine,
  type Reducer,
} from "../../index";
import { arbMsg, arbMsgSequence } from "../arbitraries";
import {
  PropertyFailure,
  type PropertyRun,
  propertyInvariant,
  propertyTerminates,
  propertyTrace,
} from "./property";
import { foldEvents } from "./replay-fold";
import { HAS_ERROR_WITH_CAUSE, MAJOR } from "./test-fast-check";

// A machine that lands a proved head, restarted from whatever storage hands
// back. `land` lands the state's `proof`, so a saved state whose proof names
// another head lands a head that was never sent: the hole experiment 121's
// saved-state property found. `guarded` is the same machine with an `init` that
// refuses such a state, so it has no bad state to reach.

const SENT_HEAD = "sent";

type State =
  | { readonly type: "idle" }
  | {
      readonly type: "proving";
      readonly head: string;
      readonly proof: string;
    }
  | { readonly type: "landed"; readonly head: string };

type Msg = { type: "land" } | { type: "wait" } | { type: "abort" };

const update: Reducer<State, Msg, never> = {
  land: (s) =>
    s.type === "proving" ? [{ type: "landed", head: s.proof }, []] : [s, []],
  wait: (s) => [s, []],
  abort: (s) => (s.type === "proving" ? [{ type: "idle" }, []] : [s, []]),
};

const defineShip = (init: (loaded: State | null) => State) =>
  defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      ctx: {} as Record<string, never>,
    },
    init: (loaded) => [init(loaded), []],
    update,
  });

const trusting = defineShip((loaded) => loaded ?? { type: "idle" });

const guarded = defineShip((loaded) =>
  loaded?.type === "proving" && loaded.proof !== loaded.head
    ? { type: "idle" }
    : (loaded ?? { type: "idle" }),
);

const msgArb = arbMsg<Msg>({
  land: fc.constant({ type: "land" as const }),
  wait: fc.constant({ type: "wait" as const }),
  abort: fc.constant({ type: "abort" as const }),
});

const seqArb = arbMsgSequence(msgArb, { maxLength: 30 });

const BAD_STATE: State = { type: "proving", head: SENT_HEAD, proof: "other" };

const GOOD_STATE: State = {
  type: "proving",
  head: SENT_HEAD,
  proof: SENT_HEAD,
};

const savedStates = fc.constantFrom<State>(
  { type: "idle" },
  GOOD_STATE,
  { type: "landed", head: SENT_HEAD },
  BAD_STATE,
);

const landsWhatWasSent = (s: State): boolean =>
  s.type !== "landed" || s.head === SENT_HEAD;

const SEEDS = [1, 42, 20261101];

type ShipMachine = typeof trusting;
type Opts = NonNullable<
  Parameters<
    typeof propertyTerminates<State, Msg, never, never, Record<string, never>>
  >[4]
>;

// The one law, through each runner's own predicate shape.
const RUNNERS: readonly (readonly [
  string,
  (machine: ShipMachine, opts: Opts) => PropertyRun,
])[] = [
  [
    "propertyTerminates",
    (machine, opts) =>
      propertyTerminates(machine, {}, seqArb, landsWhatWasSent, opts),
  ],
  [
    "propertyInvariant",
    (machine, opts) =>
      propertyInvariant(
        machine,
        {},
        seqArb,
        ({ next }) => landsWhatWasSent(next),
        opts,
      ),
  ],
  [
    "propertyTrace",
    (machine, opts) =>
      propertyTrace(
        machine,
        {},
        seqArb,
        (_steps, final) => landsWhatWasSent(final),
        opts,
      ),
  ],
];

/** The error `act` throws, read as a `PropertyFailure`. */
const failureOf = (act: () => unknown): PropertyFailure => {
  try {
    act();
  } catch (error) {
    expect(error).toBeInstanceOf(PropertyFailure);
    return error as PropertyFailure;
  }
  throw new Error("expected the property to fail, and it passed");
};

/** A check that fails once a list holds a `land`, so it shrinks to one Msg. */
const failingRun = (opts: Opts): PropertyRun =>
  propertyTerminates(
    trusting,
    {},
    arbMsgSequence(msgArb, { minLength: 5, maxLength: 30 }),
    (s) => s.type !== "landed",
    { loaded: GOOD_STATE, ...opts },
  );

describe.each(RUNNERS)("%s over drawn saved states", (_name, run) => {
  it.each(SEEDS)("finds the bad state, seed %i", (seed) => {
    const failure = failureOf(() =>
      run(trusting, { loaded: savedStates, seed }),
    );

    const drawnState = JSON.stringify(BAD_STATE);
    expect(failure.message).toContain(
      `Counterexample: [[{"type":"land"}],${drawnState}]`,
    );
    expect(failure.run.seed).toBe(seed);
  });

  it.each(SEEDS)("passes on a machine with no bad state, seed %i", (seed) => {
    expect(run(guarded, { loaded: savedStates, seed }).numRuns).toBe(200);
  });
});

describe("a fixed loaded, null, and no loaded", () => {
  const drawnBy = (seed: number, opts: Opts): string[] => {
    const lists: string[] = [];
    propertyTrace(
      trusting,
      {},
      seqArb,
      (steps) => {
        lists.push(JSON.stringify(steps.map((step) => step.msg)));
        return true;
      },
      { seed, ...opts },
    );
    return lists;
  };

  const drawnByFastCheck = (seed: number): string[] => {
    const lists: string[] = [];
    fc.assert(
      fc.property(seqArb, (msgs) => {
        lists.push(JSON.stringify(msgs));
      }),
      { seed, numRuns: 200 },
    );
    return lists;
  };

  it.each(SEEDS)("draw what a plain fast-check run draws, seed %i", (seed) => {
    const expected = drawnByFastCheck(seed);
    expect(drawnBy(seed, {})).toEqual(expected);
    expect(drawnBy(seed, { loaded: null })).toEqual(expected);
    expect(drawnBy(seed, { loaded: GOOD_STATE })).toEqual(expected);
  });

  it("boot from that value, or fresh", () => {
    const firstStates = (opts: Opts): Set<string> => {
      const seen = new Set<string>();
      propertyTrace(
        trusting,
        {},
        arbMsgSequence(msgArb, { minLength: 1, maxLength: 5 }),
        (steps) => {
          seen.add(JSON.stringify(steps[0]?.prev));
          return true;
        },
        { numRuns: 20, ...opts },
      );
      return seen;
    };

    const fresh = new Set([JSON.stringify({ type: "idle" })]);
    expect(firstStates({})).toEqual(fresh);
    expect(firstStates({ loaded: null })).toEqual(fresh);
    expect(firstStates({ loaded: GOOD_STATE })).toEqual(
      new Set([JSON.stringify(GOOD_STATE)]),
    );
  });

  it("boot fresh from a drawn null, beside the drawn states", () => {
    const seen = new Set<string>();
    propertyTrace(
      trusting,
      {},
      arbMsgSequence(msgArb, { minLength: 1, maxLength: 5 }),
      (steps) => {
        seen.add(JSON.stringify(steps[0]?.prev));
        return true;
      },
      { loaded: fc.constantFrom<State | null>(null, GOOD_STATE), seed: 1 },
    );

    expect(seen).toEqual(
      new Set([JSON.stringify({ type: "idle" }), JSON.stringify(GOOD_STATE)]),
    );
  });

  it("reads a saved state that merely has a generate field as a value", () => {
    const lookalike = {
      type: "landed",
      head: SENT_HEAD,
      generate: "not a function",
    } as State;
    propertyTrace(
      trusting,
      {},
      seqArb,
      (_steps, final) => final === lookalike,
      { loaded: lookalike, numRuns: 5 },
    );
  });

  it("throw an Error with fast-check's report on a failure", () => {
    const failure = failureOf(() =>
      propertyTerminates(trusting, {}, seqArb, landsWhatWasSent, {
        loaded: BAD_STATE,
        seed: 1,
      }),
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toMatch(
      /^Property failed after \d+ tests\n\{ seed: 1, path: "[\d:]+", endOnFailure: true \}\nCounterexample: /,
    );
  });

  it("keep numRuns at 200", () => {
    let calls = 0;
    const run = propertyTrace(trusting, {}, seqArb, () => {
      calls += 1;
      return true;
    });
    expect(calls).toBe(200);
    expect(run.numRuns).toBe(200);
  });
});

describe("fast-check's parameters", () => {
  it.each(SEEDS)("replay one failure from seed and path, seed %i", (seed) => {
    const failure = failureOf(() => failingRun({ seed }));
    const { path } = failure.run;
    if (path === null) throw new Error("a failure with no path");

    const replayed: string[] = [];
    const replay = failureOf(() =>
      propertyTrace(
        trusting,
        {},
        arbMsgSequence(msgArb, { minLength: 5, maxLength: 30 }),
        (steps, final) => {
          replayed.push(JSON.stringify(steps.map((step) => step.msg)));
          return final.type !== "landed";
        },
        {
          loaded: GOOD_STATE,
          seed: failure.run.seed,
          path,
          endOnFailure: true,
        },
      ),
    );

    // Only the one failing list ran, and it is the shrunk one.
    expect(replayed).toHaveLength(1);
    expect(failure.message).toContain(`Counterexample: [${replayed[0]}]`);
    expect(replay.run.seed).toBe(seed);
    expect(replay.run.path).toBe(path);
  });

  it("endOnFailure stops the shrinking", () => {
    const seed = SEEDS[0] as number;
    const shrunk = failureOf(() => failingRun({ seed }));
    const unshrunk = failureOf(() => failingRun({ seed, endOnFailure: true }));

    expect(shrunk.run.numShrinks).toBeGreaterThan(0);
    expect(unshrunk.run.numShrinks).toBe(0);
  });

  describe("interruptAfterTimeLimit", () => {
    const slow = () => {
      const until = Date.now() + 2;
      while (Date.now() < until);
      return true;
    };
    const interrupted = (markInterruptAsFailure: boolean) =>
      propertyTrace(trusting, {}, seqArb, slow, {
        numRuns: 1_000_000,
        interruptAfterTimeLimit: 20,
        markInterruptAsFailure,
      });

    it("ends the run early and passes on its own", () => {
      expect(interrupted(false).numRuns).toBeLessThan(1_000_000);
    });

    it("fails with markInterruptAsFailure, and no path to replay", () => {
      const failure = failureOf(() => interrupted(true));
      expect(failure.message).toMatch(/^Property interrupted after \d+ tests/);
      expect(failure.run.numRuns).toBeLessThan(1_000_000);
      expect(failure.run.path).toBeNull();
    });
  });
});

// tea promises fast-check ^3 and ^4, and they keep the check's error in different
// places. This file also runs on each version in `packages/tea/fast-check-peers`, so
// nothing below may assume one: each row is either `fc.assert`'s own answer or keyed
// on the major, or the setting, that is actually loaded.
describe("what the check threw", () => {
  const WHY = "the check said why";

  const throwsOnLand = (s: State): void => {
    if (s.type === "landed") throw new Error(WHY);
  };

  const viaAssert = (settings: Opts): Error => {
    try {
      fc.assert(
        fc.property(seqArb, (msgs) => {
          throwsOnLand(foldEvents(trusting, {}, GOOD_STATE, msgs).finalState);
        }),
        { numRuns: 200, seed: 1, ...settings },
      );
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected fc.assert to fail, and it passed");
  };

  const viaRunner = (settings: Opts): PropertyFailure =>
    failureOf(() =>
      propertyTrace(
        trusting,
        {},
        seqArb,
        (_steps, final) => {
          throwsOnLand(final);
          return true;
        },
        { loaded: GOOD_STATE, seed: 1, ...settings },
      ),
    );

  // A report quotes a stack on some settings, and two call sites never share one.
  const withoutStack = (message: string): string =>
    message.split(/\n\s*at /)[0] ?? message;
  const causeMessage = (error: Error): string | undefined =>
    error.cause instanceof Error ? error.cause.message : undefined;

  // Each major ignores the setting it does not know, so one table covers both.
  const SETTINGS = [
    ["the defaults", {}],
    ["errorWithCause", { errorWithCause: true }],
    ["includeErrorInReport", { includeErrorInReport: true }],
    ["verbose", { verbose: 2 }],
  ] as readonly (readonly [string, Opts])[];

  it.each(
    SETTINGS,
  )("sits where fc.assert puts it, on %s", (_name, settings) => {
    const expected = viaAssert(settings);
    const actual = viaRunner(settings);

    expect(withoutStack(actual.message)).toBe(withoutStack(expected.message));
    expect("cause" in actual).toBe("cause" in expected);
    expect(causeMessage(actual)).toBe(causeMessage(expected));
  });

  // The reason a runner fails must reach its caller however the major files it:
  // losing this text is what a runner on 4 did before.
  it.each(RUNNERS)("%s keeps its own explanation", (name, run) => {
    const failure = failureOf(() =>
      run(trusting, { loaded: BAD_STATE, seed: 1 }),
    );

    if (MAJOR >= 4) {
      expect(failure.cause).toBeInstanceOf(Error);
      expect(causeMessage(failure)).toContain(`${name}:`);
    } else {
      expect(failure.message).toContain(`${name}:`);
    }
  });

  it.runIf(HAS_ERROR_WITH_CAUSE && MAJOR < 4)(
    "errorWithCause moves it to the cause on 3",
    () => {
      const failure = viaRunner({ errorWithCause: true });
      expect(causeMessage(failure)).toBe(WHY);
    },
  );

  it.runIf(MAJOR >= 4)(
    "includeErrorInReport moves it to the message on 4",
    () => {
      const failure = viaRunner({ includeErrorInReport: true } as Opts);
      expect(failure.cause).toBeUndefined();
      expect(failure.message).toContain(WHY);
    },
  );
});

// A counter with three laws in one check. `up` runs past the cap, so only the
// second law can break, and it first breaks on the fourth `up`.
describe("a check that says why", () => {
  type Count = { readonly count: number };
  type CountMsg = { type: "up" } | { type: "down" } | { type: "reset" };

  const counter = defineMachine({
    types: {
      model: {} as Count,
      msg: {} as CountMsg,
      ctx: {} as Record<string, never>,
    },
    init: () => [{ count: 0 }, []],
    update: {
      up: (s) => [{ count: s.count + 1 }, []],
      down: (s) => [{ count: Math.max(0, s.count - 1) }, []],
      reset: () => [{ count: 0 }, []],
    } satisfies Reducer<Count, CountMsg, never>,
  });

  const countMsgs = arbMsgSequence(
    arbMsg<CountMsg>({
      up: fc.constant({ type: "up" as const }),
      down: fc.constant({ type: "down" as const }),
      reset: fc.constant({ type: "reset" as const }),
    }),
    { maxLength: 30 },
  );

  const FIRST = "the count went negative";
  const SECOND = "the count passed its cap of 3";
  const THIRD = "a reset left a count behind";

  const firstLaw = (s: Count) => (s.count < 0 ? FIRST : null);
  const secondLaw = (s: Count) => (s.count > 3 ? SECOND : null);
  const thirdLaw = (msg: CountMsg, s: Count) =>
    msg.type === "reset" && s.count !== 0 ? THIRD : null;

  // Declared here rather than taken from fast-check's types: 4 does not know
  // `errorWithCause`, and this file's tests run on both majors.
  type CauseSetting = { readonly errorWithCause?: boolean };

  const threeLawsOnEachStep = (
    seed: number,
    settings?: CauseSetting,
  ): PropertyRun =>
    propertyInvariant(
      counter,
      {},
      countMsgs,
      ({ msg, next }) =>
        firstLaw(next) ?? secondLaw(next) ?? thirdLaw(msg, next),
      { seed, ...settings },
    );

  const threeLawsOverTheTrace = (
    seed: number,
    settings?: CauseSetting,
  ): PropertyRun =>
    propertyTrace(
      counter,
      {},
      countMsgs,
      (steps) => {
        for (const { msg, next } of steps) {
          const broken =
            firstLaw(next) ?? secondLaw(next) ?? thirdLaw(msg, next);
          if (broken !== null) return broken;
        }
        return null;
      },
      { seed, ...settings },
    );

  const THREE_LAWS = [
    ["propertyInvariant", threeLawsOnEachStep],
    ["propertyTrace", threeLawsOverTheTrace],
  ] as const;

  const up = JSON.stringify({ type: "up" });
  const SHRUNK = `Counterexample: [[${[up, up, up, up].join(",")}]]`;

  describe.each(THREE_LAWS)("%s with three laws", (_name, run) => {
    it.each(SEEDS)("names the law that broke, seed %i", (seed) => {
      const failure = failureOf(() => run(seed));

      expect(failure.message).toContain(SECOND);
      expect(failure.message).toContain(SHRUNK);
      expect(failure.message).not.toContain(FIRST);
      expect(failure.message).not.toContain(THIRD);
      expect(failure.run.seed).toBe(seed);
    });

    it("says it once, wherever fast-check files what a check threw", () => {
      const { message } = failureOf(() => run(1));
      expect(message.split(SECOND)).toHaveLength(2);
    });

    // Fast-check 4 files a throw in `cause` by default, and this setting is how a
    // 3 that has it reaches that same arm. A 3 without it never files one there.
    it.runIf(HAS_ERROR_WITH_CAUSE || MAJOR >= 4)(
      "says it once when fast-check files the throw in cause",
      () => {
        const failure = failureOf(() => run(1, { errorWithCause: true }));

        expect(failure.cause).toBeInstanceOf(Error);
        expect(failure.message.split(SECOND)).toHaveLength(2);
        expect(failure.message).toContain(SHRUNK);
      },
    );
  });

  const ANSWERS: readonly (readonly [
    string,
    boolean | string | null,
    "holds" | "fails",
  ])[] = [
    ["true", true, "holds"],
    ["null", null, "holds"],
    ["false", false, "fails"],
    ["a reason", "why", "fails"],
    ["an empty string", "", "fails"],
  ];

  const ANSWERING: readonly (readonly [
    string,
    (answer: boolean | string | null) => PropertyRun,
  ])[] = [
    [
      "propertyInvariant",
      (answer) =>
        propertyInvariant(counter, {}, countMsgs, () => answer, {
          seed: 1,
          numRuns: 20,
        }),
    ],
    [
      "propertyTrace",
      (answer) =>
        propertyTrace(counter, {}, countMsgs, () => answer, {
          seed: 1,
          numRuns: 20,
        }),
    ],
  ];

  describe.each(ANSWERING)("%s reads each answer", (_name, run) => {
    it.each(ANSWERS)("%s", (_label, answer, expected) => {
      if (expected === "holds") {
        expect(run(answer).numRuns).toBe(20);
      } else {
        expect(failureOf(() => run(answer))).toBeInstanceOf(PropertyFailure);
      }
    });
  });

  // Where a runner's own text lands differs by major, so read both places.
  const allText = (failure: PropertyFailure): string =>
    failure.cause instanceof Error
      ? `${failure.message}\n${failure.cause.message}`
      : failure.message;

  it("propertyTrace's failure carries the reason and what it prints today", () => {
    const text = allText(failureOf(() => threeLawsOverTheTrace(1)));
    expect(text).toContain(SECOND);
    expect(text).toContain("propertyTrace: predicate failed on trace length=4");
    expect(text).toContain(`final=${JSON.stringify({ count: 4 })}`);
  });

  it("propertyInvariant's failure carries the reason and the step", () => {
    const text = allText(failureOf(() => threeLawsOnEachStep(1)));
    expect(text).toContain(SECOND);
    expect(text).toContain(`propertyInvariant: failed at step msg=${up}`);
  });

  it("a plain false reports exactly what fc.assert reports", () => {
    const viaAssert = (): Error => {
      try {
        fc.assert(
          fc.property(countMsgs, (msgs) => {
            const { steps } = foldEvents(counter, {}, null, msgs);
            for (const step of steps) {
              if (step.next.count > 3) {
                throw new Error(
                  `propertyInvariant: failed at step msg=${JSON.stringify(step.msg)} ` +
                    `prev=${JSON.stringify(step.prev)} next=${JSON.stringify(step.next)} ` +
                    `cmds=${JSON.stringify(step.cmds)}`,
                );
              }
            }
          }),
          { seed: 1, numRuns: 200 },
        );
      } catch (error) {
        return error as Error;
      }
      throw new Error("expected fc.assert to fail, and it passed");
    };
    const failure = failureOf(() =>
      propertyInvariant(counter, {}, countMsgs, ({ next }) => next.count <= 3, {
        seed: 1,
      }),
    );

    const withoutStack = (message: string): string =>
      message.split(/\n\s*at /)[0] ?? message;
    expect(withoutStack(failure.message)).toBe(
      withoutStack(viaAssert().message),
    );
    expect(failure.message).not.toContain("reason:");
  });

  it("a check that throws still fails with its own message", () => {
    const failure = failureOf(() =>
      propertyInvariant(
        counter,
        {},
        countMsgs,
        ({ next }) => {
          if (next.count > 3) throw new Error("the check threw this");
          return null;
        },
        { seed: 1 },
      ),
    );
    expect(allText(failure)).toContain("the check threw this");
    expect(failure.message).not.toContain("reason:");
  });

  it("propertyTerminates still fails on a boolean alone", () => {
    const failure = failureOf(() =>
      propertyTerminates(counter, {}, countMsgs, (s) => s.count <= 3, {
        seed: 1,
      }),
    );
    expect(allText(failure)).toContain("propertyTerminates:");
    expect(failure.message).not.toContain("reason:");
  });
});

describe("what a run hands back", () => {
  it.each(RUNNERS)("%s returns its counts on a pass", (_name, run) => {
    expect(run(guarded, { loaded: savedStates, seed: 7, numRuns: 25 })).toEqual(
      {
        numRuns: 25,
        numShrinks: 0,
        seed: 7,
        path: null,
        msgCounts: expect.any(Map),
      },
    );
  });

  it.each(RUNNERS)("%s throws the same shape on a failure", (_name, run) => {
    const failure = failureOf(() =>
      run(trusting, { loaded: savedStates, seed: 7 }),
    );

    expect(failure.name).toBe("PropertyFailure");
    expect(failure._tag).toBe("PropertyFailure");
    expect(Object.keys(failure.run).sort()).toEqual(
      Object.keys({
        numRuns: 0,
        numShrinks: 0,
        seed: 0,
        path: null,
        msgCounts: new Map(),
      } satisfies PropertyRun).sort(),
    );
    expect(failure.run.numRuns).toBeGreaterThan(0);
    expect(failure.run.numRuns).toBeLessThanOrEqual(200);
    expect(failure.run.seed).toBe(7);
    expect(failure.run.path).toMatch(/^\d+(:\d+)*$/);
  });

  it("reads the shrinks a failure took, with no text to parse", () => {
    const { run } = failureOf(() => failingRun({ seed: 1 }));
    expect(run.numShrinks).toBeGreaterThan(0);
    expect(run.path?.split(":").length).toBe(run.numShrinks + 1);
  });

  it("counts the shrinks once, however many times shrinking re-runs the check", () => {
    let calls = 0;
    const failure = failureOf(() =>
      propertyTrace(
        trusting,
        {},
        seqArb,
        (_steps, final) => {
          calls += 1;
          return landsWhatWasSent(final);
        },
        { loaded: savedStates, seed: 7 },
      ),
    );
    expect(calls).toBeGreaterThan(failure.run.numRuns);
    expect(failure.run.numRuns + failure.run.numShrinks).toBeLessThanOrEqual(
      calls,
    );
  });
});

// A call using no new option behaves as it did under `fc.assert`, and that includes a
// reporter someone set for the whole process. Each row is `fc.assert`'s own answer, so
// it holds on either major.
describe("a reporter set through fc.configureGlobal", () => {
  const before = fc.readConfigureGlobal();
  afterEach(() => {
    fc.resetConfigureGlobal();
    fc.configureGlobal(before);
  });

  const viaAssert = (law: (s: State) => boolean): void => {
    fc.assert(
      fc.property(seqArb, (msgs) => {
        if (!law(foldEvents(trusting, {}, BAD_STATE, msgs).finalState)) {
          throw new Error("the law broke");
        }
      }),
      { numRuns: 200, seed: 1 },
    );
  };
  const viaRunner = (law: (s: State) => boolean, opts?: Opts): PropertyRun =>
    propertyTerminates(trusting, {}, seqArb, law, {
      loaded: BAD_STATE,
      seed: 1,
      ...opts,
    });

  const LAWS = [
    ["a failing run", landsWhatWasSent, true],
    ["a passing run", () => true, false],
  ] as const;

  it.each(
    LAWS,
  )("%s takes the details and throws nothing", (_name, law, failed) => {
    const seen: boolean[] = [];
    fc.configureGlobal({ reporter: (details) => seen.push(details.failed) });

    expect(() => viaAssert(law)).not.toThrow();
    expect(seen).toEqual([failed]);

    seen.length = 0;
    expect(() => viaRunner(law)).not.toThrow();
    expect(seen).toEqual([failed]);
  });

  it("hands back the run it reported, failure and all", () => {
    fc.configureGlobal({ reporter: () => {} });

    const run = viaRunner(landsWhatWasSent);
    expect(run.path).not.toBeNull();
    expect(run.numShrinks).toBeGreaterThanOrEqual(0);
  });

  it("lets what the reporter throws reach the caller", () => {
    const thrown = new Error("the reporter's own");
    fc.configureGlobal({
      reporter: () => {
        throw thrown;
      },
    });

    expect(() => viaAssert(landsWhatWasSent)).toThrow(thrown);
    expect(() => viaRunner(landsWhatWasSent)).toThrow(thrown);
  });

  it("refuses a global asyncReporter the way fc.assert does", () => {
    fc.configureGlobal({ asyncReporter: async () => {} });

    expect(() => viaAssert(landsWhatWasSent)).toThrow(/asyncReporter/);
    expect(() => viaRunner(landsWhatWasSent)).toThrow(/asyncReporter/);
  });

  it("failOnNeverActed still fails a run that passed", () => {
    fc.configureGlobal({ reporter: () => {} });
    // Nothing acts from `idle`, and this machine never leaves it.
    const stuck = defineShip(() => ({ type: "idle" }));

    const failure = failureOf(() =>
      propertyTerminates(stuck, {}, seqArb, () => true, {
        failOnNeverActed: true,
      }),
    );
    expect(failure.message).toContain("never acted");
  });

  it("failOnNeverActed stays out of a failure the reporter already took", () => {
    fc.configureGlobal({ reporter: () => {} });

    expect(() =>
      viaRunner(() => false, { failOnNeverActed: true }),
    ).not.toThrow();
  });

  it("a reporter passed per call still can't hide a failure", () => {
    const seen: unknown[] = [];
    const reporter = (details: unknown) => seen.push(details);
    const dodged = { reporter } as Opts;

    expect(() => viaRunner(landsWhatWasSent, dodged)).toThrow(PropertyFailure);
    expect(seen).toEqual([]);
  });
});

// A helper like `(seed?: number) => propertyTrace(..., { seed })` hands the runner
// a key set to `undefined`. That key has to leave the global setting in place, as
// the runners' old `opts?.seed !== undefined` did, and `fc.assert` with no such key
// is the answer to match.
describe("a setting left undefined under fc.configureGlobal", () => {
  const before = fc.readConfigureGlobal();
  afterEach(() => {
    fc.resetConfigureGlobal();
    fc.configureGlobal(before);
  });

  const NUM_RUNS = 20;

  const viaAssert = (): readonly (readonly Msg[])[] => {
    const lists: (readonly Msg[])[] = [];
    fc.assert(
      fc.property(seqArb, (msgs) => {
        lists.push(msgs);
      }),
      { numRuns: NUM_RUNS },
    );
    return lists;
  };
  const viaRunner = (seed: number | undefined): readonly (readonly Msg[])[] => {
    const lists: (readonly Msg[])[] = [];
    propertyTrace(
      trusting,
      {},
      seqArb,
      (steps) => {
        lists.push(steps.map((step) => step.msg));
        return true;
      },
      { numRuns: NUM_RUNS, seed },
    );
    return lists;
  };

  it.each(SEEDS)("seed: undefined draws global seed %i's lists", (seed) => {
    fc.configureGlobal({ seed });

    const expected = viaAssert();
    expect(viaRunner(undefined)).toEqual(expected);
  });

  it("a seed of its own still wins over the global one", () => {
    fc.configureGlobal({ seed: 1 });
    const fromGlobal = viaRunner(undefined);

    fc.resetConfigureGlobal();
    fc.configureGlobal({ seed: 2 });
    expect(viaRunner(1)).toEqual(fromGlobal);
  });

  it("holds for any forwarded setting, not only seed", () => {
    fc.configureGlobal({ endOnFailure: true });

    const failure = failureOf(() =>
      failingRun({ seed: 1, endOnFailure: undefined }),
    );
    expect(failure.run.numShrinks).toBe(0);
  });

  it("numRuns: undefined still defaults to 200, whatever is global", () => {
    fc.configureGlobal({ numRuns: NUM_RUNS });

    const run = propertyTerminates(trusting, {}, seqArb, () => true, {
      numRuns: undefined,
    });
    expect(run.numRuns).toBe(200);
  });
});

// A machine written as a plain object, or a built one spread with a new `cmds`,
// can list two Cmds under one name, which `defineMachine` refuses. A runner
// refuses it too, before its first fold, as `run` and `drive` do.
describe.each(
  RUNNERS,
)("%s given a cmds list that names one Cmd twice", (_name, run) => {
  const input = z.object({ path: z.string() });
  const own = ["list_dir", "hash", "resize", "notify"].map((name) =>
    Cmd.define(name, {
      input,
      ok: z.object({ n: z.number() }),
      err: ["offline"],
    }),
  );
  const fetchFile = Cmd.define("fetch_file", {
    input,
    ok: z.object({ bytes: z.number() }),
    err: ["offline"],
  });
  const fetchText = Cmd.define("fetch_file", {
    input,
    ok: z.object({ text: z.string() }),
    err: ["offline"],
  });

  /** `trusting` spread with a `cmds` the maker would not build, counting its boots. */
  const listing = (cmds: readonly AnyCmdDef[]) => {
    const boots = { count: 0 };
    const machine: ShipMachine = {
      ...trusting,
      init: (loaded, ctx) => {
        boots.count += 1;
        return trusting.init(loaded, ctx);
      },
      cmds,
    };
    return { machine, boots };
  };

  /** The error `act` throws; fails when it throws nothing. */
  const thrownBy = (act: () => unknown): unknown => {
    try {
      act();
    } catch (error) {
      return error;
    }
    throw new Error("expected the runner to throw, and it passed");
  };

  const refused = [
    ["two defs under one name", [...own, fetchFile, fetchText]],
    ["one def listed twice", [...own, fetchFile, fetchFile]],
  ] as const;

  describe.each(refused)("%s", (_listed, cmds) => {
    it.each([
      ["by default", {}],
      ["with failOnUndeclaredCmd", { failOnUndeclaredCmd: true }],
    ] as const)("throws CmdNameCollisionError naming the Cmd, %s, before it folds", (_how, opts) => {
      const { machine, boots } = listing(cmds);
      const error = thrownBy(() => run(machine, { seed: 1, ...opts }));
      expect(error).toBeInstanceOf(CmdNameCollisionError);
      expect(error).toMatchObject({ cmdType: "fetch_file" });
      expect(boots.count).toBe(0);
    });
  });

  it("runs a list whose names are all distinct", () => {
    const { machine, boots } = listing([...own, fetchFile]);
    expect(run(machine, { seed: 1, failOnUndeclaredCmd: true }).numRuns).toBe(
      200,
    );
    expect(boots.count).toBeGreaterThan(0);
  });
});
