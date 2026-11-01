import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Cmd, defineMachine, type Reducer, type Settled } from "../../index";
import { arbMsg, arbMsgSequence } from "../arbitraries";
import {
  PropertyFailure,
  type PropertyRun,
  propertyInvariant,
} from "./property";
import type { Step } from "./replay-fold";

// Epic #765's realistic case: what experiment 121 wrote about 67 lines around, in
// the runner's own options. A ship machine climbs 20 checks before `release` can
// act, so a green run that names `release` as acted has been 20 steps deep.

const DEEP = 20;

const fetch = Cmd.define("fetch", {
  input: z.object({ url: z.string() }),
  ok: z.object({ body: z.string() }),
  err: ["timeout"],
});

type FetchCmd = ReturnType<typeof fetch>;

type State = {
  readonly level: number;
  readonly notes: number;
  readonly synced: number;
  readonly failed: number;
  readonly shipped: number;
};

type Msg =
  | { readonly type: "climb" }
  | { readonly type: "note" }
  | { readonly type: "sync" }
  | { readonly type: "release" }
  | Settled<typeof fetch>;

const FRESH: State = { level: 0, notes: 0, synced: 0, failed: 0, shipped: 0 };

const update: Reducer<State, Msg, FetchCmd> = {
  climb: (s) => (s.level < DEEP ? [{ ...s, level: s.level + 1 }, []] : [s, []]),
  note: (s) => [{ ...s, notes: s.notes + 1 }, []],
  sync: (s) => [s, [fetch({ url: "status" })]],
  release: (s) =>
    s.level === DEEP ? [{ ...s, shipped: s.shipped + 1 }, []] : [s, []],
  fetch_ok: (s) => [{ ...s, synced: s.synced + 1 }, []],
  fetch_err: (s) => [{ ...s, failed: s.failed + 1 }, []],
};

const defineShip = ({
  cells = update,
  initCmds = [],
}: {
  readonly cells?: Reducer<State, Msg, FetchCmd>;
  readonly initCmds?: readonly FetchCmd[];
}) =>
  defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      cmd: {} as FetchCmd,
      ctx: {} as Record<string, never>,
    },
    cmds: [fetch],
    init: (loaded) => [loaded ?? FRESH, initCmds],
    update: cells,
  });

const SENT = fetch({ url: "status" });

const msgArb = arbMsg<Msg>({
  climb: fc.constant({ type: "climb" as const }),
  note: fc.constant({ type: "note" as const }),
  sync: fc.constant({ type: "sync" as const }),
  release: fc.constant({ type: "release" as const }),
  fetch_ok: fc.constant(fetch.ok(SENT, { body: "green" }, 0)),
  fetch_err: fc.constant(fetch.err(SENT, { _tag: "timeout" }, 0)),
});

const SAVED: readonly State[] = [
  FRESH,
  { ...FRESH, level: 1, notes: 2 },
  { ...FRESH, level: 2, synced: 1 },
];

const LAW_CAP = "a level never passes the top";
const LAW_RELEASE = "only the top level releases";
const LAW_NOTES = "notes only grow";

const threeLaws = ({
  prev,
  next,
}: Step<State, Msg, FetchCmd>): string | null => {
  if (next.level > DEEP) return LAW_CAP;
  if (next.shipped > prev.shipped && prev.level !== DEEP) return LAW_RELEASE;
  return next.notes < prev.notes ? LAW_NOTES : null;
};

const SEEDS = [1, 42, 20261101];

const run = (
  machine: ReturnType<typeof defineShip>,
  seed: number,
  maxLength?: number,
) =>
  propertyInvariant(
    machine,
    {},
    arbMsgSequence(msgArb, { size: "max", maxLength: maxLength ?? 300 }),
    threeLaws,
    {
      seed,
      loaded: fc.constantFrom(...SAVED),
      failOnNeverActed: true,
      failOnUndeclaredCmd: true,
    },
  );

const failureOf = (act: () => PropertyRun): PropertyFailure => {
  try {
    act();
  } catch (error) {
    expect(error).toBeInstanceOf(PropertyFailure);
    return error as PropertyFailure;
  }
  throw new Error("expected the property to fail, and it passed");
};

describe("a test author replaces experiment 121's workarounds", () => {
  it.each(SEEDS)("the healthy machine passes, seed %i", (seed) => {
    const passed = run(defineShip({}), seed);

    expect(passed.numRuns).toBe(200);
    expect(passed.numShrinks).toBe(0);
    expect(passed.seed).toBe(seed);
    expect([...passed.msgCounts.keys()]).toEqual(Object.keys(update));
    for (const [, { drawn, acted }] of passed.msgCounts) {
      expect(drawn).toBeGreaterThan(0);
      expect(acted).toBeGreaterThan(0);
    }
  });

  // What the `failOnNeverActed` docs warn about: the default `maxLength` of 30 can't
  // reach 20 steps deep when only one draw in 6 climbs, and the depth times the
  // number of types can.
  it.each(
    SEEDS,
  )("the healthy machine reads as cut at the default maxLength, seed %i", (seed) => {
    const failure = failureOf(() => run(defineShip({}), seed, 30));

    expect(failure.message).toContain("1 Msg type(s) never acted");
    expect(failure.message).toContain("release (drawn");
  });

  it.each(
    SEEDS,
  )("the healthy machine passes at the depth times the types, seed %i", (seed) => {
    expect(run(defineShip({}), seed, DEEP * 6).numRuns).toBe(200);
  });
});

describe("each failure names itself", () => {
  describe.each(SEEDS)("seed %i", (seed) => {
    it("a cut path names the Msg type that never acted", () => {
      const cut = defineShip({
        cells: { ...update, release: (s) => [s, []] },
      });
      const failure = failureOf(() => run(cut, seed));

      expect(failure.message).toContain("1 Msg type(s) never acted");
      expect(failure.message).toContain("release (drawn");
      expect(failure.run.path).toBeNull();
      expect(failure.run.msgCounts.get("release")?.acted).toBe(0);
    });

    it("a broken second law gives its reason, the drawn state and the shrunk list", () => {
      const broken = defineShip({
        cells: {
          ...update,
          release: (s) => [{ ...s, shipped: s.shipped + 1 }, []],
        },
      });
      const failure = failureOf(() => run(broken, seed));

      expect(failure.message).toContain(LAW_RELEASE);
      expect(failure.message).not.toContain(LAW_CAP);
      expect(failure.message).not.toContain(LAW_NOTES);
      expect(failure.message).toContain(
        `Counterexample: [[${JSON.stringify({ type: "release" })}],${JSON.stringify(FRESH)}]`,
      );
    });

    it("a reducer sending junk names the Cmd", () => {
      const junk = defineShip({
        cells: {
          ...update,
          sync: (s) => [s, ["Stryker was here" as unknown as FetchCmd]],
        },
      });
      const failure = failureOf(() => run(junk, seed));

      expect(failure.message).toContain(`"Stryker was here" isn't a Cmd`);
    });

    it("an init sending junk names the Cmd", () => {
      const junk = defineShip({
        initCmds: [{ type: "nope" } as unknown as FetchCmd],
      });
      const failure = failureOf(() => run(junk, seed));

      expect(failure.message).toContain(
        `${JSON.stringify({ type: "nope" })} isn't in machine.cmds: [fetch]`,
      );
    });
  });
});
