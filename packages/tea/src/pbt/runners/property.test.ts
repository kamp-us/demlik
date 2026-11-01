import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defineMachine, type Reducer } from "../../index";
import { arbMsg, arbMsgSequence } from "../arbitraries";
import {
  PropertyFailure,
  type PropertyRun,
  propertyInvariant,
  propertyTerminates,
  propertyTrace,
} from "./property";
import { foldEvents } from "./replay-fold";

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
// places. This file also runs with fast-check aliased to 4, so nothing below may
// assume one major: each row is either `fc.assert`'s own answer or keyed on the
// major that is actually loaded.
describe("what the check threw", () => {
  const MAJOR = Number(fc.__version.split(".")[0]);
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

  it.runIf(MAJOR < 4)("errorWithCause moves it to the cause on 3", () => {
    const failure = viaRunner({ errorWithCause: true });
    expect(causeMessage(failure)).toBe(WHY);
  });

  it.runIf(MAJOR >= 4)(
    "includeErrorInReport moves it to the message on 4",
    () => {
      const failure = viaRunner({ includeErrorInReport: true } as Opts);
      expect(failure.cause).toBeUndefined();
      expect(failure.message).toContain(WHY);
    },
  );
});

describe("what a run hands back", () => {
  it.each(RUNNERS)("%s returns its counts on a pass", (_name, run) => {
    expect(run(guarded, { loaded: savedStates, seed: 7, numRuns: 25 })).toEqual(
      { numRuns: 25, numShrinks: 0, seed: 7, path: null },
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
