import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Cmd,
  CmdNameCollisionError,
  defineMachine,
  type Reducer,
  type Settled,
  type Transitions,
} from "../../index";
import {
  PropertyFailure,
  propertyTerminates,
  propertyTrace,
} from "../runners/property";
import { foldEvents, type Step } from "../runners/replay-fold";
import { stubCtxThrowingProxy } from "./ctx";
import { arbRecordMsg } from "./msg";
import { arbGuidedSequence } from "./sequence";

// A release: `start` asks three checks at once, and the state remembers only which
// came back, never the Cmds. Three good answers send `publish`, and its good answer
// lands the run. A bad answer asks again, and so does `nudge`, so one Cmd can wait
// twice. So any run given every answer ends in `landed`, whatever the order.

const input = z.object({ ticket: z.string() });
const defined = {
  lint: Cmd.define("lint", { input, ok: z.null(), err: ["flaky"] }),
  test: Cmd.define("test", { input, ok: z.null(), err: ["flaky"] }),
  scan: Cmd.define("scan", { input, ok: z.null(), err: ["flaky"] }),
};
const publish = Cmd.define("publish", {
  input,
  ok: z.string(),
  err: ["flaky"],
});

type CheckName = keyof typeof defined;
const CHECKS = Object.keys(defined) as readonly CheckName[];
type Defs = (typeof defined)[CheckName] | typeof publish;
type Sent = ReturnType<Defs>;

type State =
  | { readonly type: "idle" }
  | {
      readonly type: "asking";
      readonly ticket: string;
      readonly got: readonly CheckName[];
    }
  | { readonly type: "publishing"; readonly ticket: string }
  | { readonly type: "landed" };

type Msg =
  | { readonly type: "start"; readonly ticket: string }
  | { readonly type: "nudge" }
  | Settled<Defs>;

const ask = (name: CheckName, ticket: string): Sent =>
  defined[name]({ ticket });

const checkOk =
  (name: CheckName) =>
  (s: State): readonly [State, readonly Sent[]] => {
    if (s.type !== "asking" || s.got.includes(name)) return [s, []];
    const got = [...s.got, name];
    return got.length < CHECKS.length
      ? [{ ...s, got }, []]
      : [
          { type: "publishing", ticket: s.ticket },
          [publish({ ticket: s.ticket })],
        ];
  };

const checkErr =
  (name: CheckName) =>
  (s: State): readonly [State, readonly Sent[]] =>
    s.type === "asking" && !s.got.includes(name)
      ? [s, [ask(name, s.ticket)]]
      : [s, []];

const update: Reducer<State, Msg, Sent> = {
  start: (s, m) =>
    s.type === "idle"
      ? [
          { type: "asking", ticket: m.ticket, got: [] },
          CHECKS.map((name) => ask(name, m.ticket)),
        ]
      : [s, []],
  nudge: (s) =>
    s.type === "asking"
      ? [
          s,
          CHECKS.filter((name) => !s.got.includes(name)).map((name) =>
            ask(name, s.ticket),
          ),
        ]
      : [s, []],
  lint_ok: checkOk("lint"),
  lint_err: checkErr("lint"),
  test_ok: checkOk("test"),
  test_err: checkErr("test"),
  scan_ok: checkOk("scan"),
  scan_err: checkErr("scan"),
  publish_ok: (s) =>
    s.type === "publishing" ? [{ type: "landed" }, []] : [s, []],
  publish_err: (s) =>
    s.type === "publishing" ? [s, [publish({ ticket: s.ticket })]] : [s, []],
};

type Ctx = Record<string, never>;
const ctx = stubCtxThrowingProxy<Ctx>();

const release = (cells: Reducer<State, Msg, Sent> = update) =>
  defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      cmd: {} as Sent,
      ctx: {} as Ctx,
    },
    cmds: [defined.lint, defined.test, defined.scan, publish],
    init: (loaded) => [loaded ?? { type: "idle" }, []],
    update: cells,
  });

const machine = release();
/** The planted break: a good `test` answer is lost, so the run never leaves `asking`. */
const dropsAnAnswer = release({ ...update, test_ok: (s) => [s, []] });

const startCell = arbRecordMsg("start", {
  ticket: fc.constantFrom("T1", "T2"),
});
const nudgeCell = fc.constant({ type: "nudge" as const });

/** A check answers good 3 times in 4, and a shrink moves a bad answer toward a good one. */
const goodOrBad = fc.nat(3).map((n) => n !== 3);

const checkCell = <D extends (typeof defined)[CheckName]>(def: D) => ({
  draw: goodOrBad,
  make: (cmd: ReturnType<D>, good: boolean): Msg =>
    (good
      ? def.ok(cmd as never, null)
      : def.err(cmd as never, { _tag: "flaky" })) as Msg,
});

const cells = {
  outside: { start: startCell, nudge: nudgeCell },
  answers: {
    lint: checkCell(defined.lint),
    test: checkCell(defined.test),
    scan: checkCell(defined.scan),
    publish: {
      draw: fc.option(fc.string({ maxLength: 8 })),
      make: (cmd: ReturnType<typeof publish>, sha: string | null): Msg =>
        sha === null
          ? publish.err(cmd, { _tag: "flaky" })
          : publish.ok(cmd, sha),
    },
  },
};

const lists = arbGuidedSequence(machine, ctx, cells);

const SEEDS = [1, 42, 20261101];
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * A second, separate reading of a list: walk its steps and name the first answer
 * that fits no Cmd sent and still waiting, then give back what still waits. It reads
 * the `cmd` every answer here carries, where the arbitrary reads its own pick.
 */
const walk = (
  initCmds: readonly unknown[],
  steps: readonly Step<State, Msg, Sent>[],
) => {
  const waiting = [...initCmds];
  for (const { msg, cmds } of steps) {
    if ("cmd" in msg) {
      const at = waiting.findIndex((cmd) => same(cmd, msg.cmd));
      if (at < 0) return { misfit: msg, waiting };
      waiting.splice(at, 1);
    }
    waiting.push(...cmds);
  }
  return { misfit: null, waiting };
};

/** The law: a run that started and got every answer has landed. */
const landsGivenEveryAnswer = (
  steps: readonly Step<State, Msg, Sent>[],
  final: State,
  initCmds: readonly Sent[],
): boolean | string =>
  steps.length === 0 ||
  final.type === "idle" ||
  walk(initCmds, steps).waiting.length > 0 ||
  final.type === "landed" ||
  `every answer came in and the run sits in ${final.type}`;

const folded = (m: typeof machine, msgs: readonly Msg[]) =>
  foldEvents(m, ctx, null, msgs);

/** A failure's whole text: a thrown reason sits in the message on fast-check 3, in `cause` on 4. */
const told = ({ message, cause }: PropertyFailure): string =>
  `${message}\n${cause instanceof Error ? cause.message : ""}`;

const failureOf = (act: () => unknown): PropertyFailure => {
  try {
    act();
  } catch (error) {
    expect(error).toBeInstanceOf(PropertyFailure);
    return error as PropertyFailure;
  }
  throw new Error("expected the property to fail, and it passed");
};

describe("a test author checks that something must happen, on random lists", () => {
  it.each(SEEDS)("a run given every answer lands, seed %i", (seed) => {
    let finished = 0;
    let landed = 0;
    const run = propertyTrace(
      machine,
      ctx,
      lists,
      (steps, final, initCmds) => {
        if (
          final.type !== "idle" &&
          walk(initCmds, steps).waiting.length === 0
        ) {
          finished++;
          if (final.type === "landed") landed++;
        }
        return landsGivenEveryAnswer(steps, final, initCmds);
      },
      { seed, numRuns: 500 },
    );
    expect(run.numRuns).toBe(500);
    // The law is no use if no list gets that far.
    expect(finished).toBeGreaterThan(25);
    expect(landed).toBe(finished);
  });

  it.each(
    SEEDS,
  )("a broken copy that drops one answer fails with a shrunk list, seed %i", (seed) => {
    const failure = failureOf(() =>
      propertyTrace(dropsAnAnswer, ctx, lists, landsGivenEveryAnswer, {
        seed,
        numRuns: 500,
      }),
    );
    expect(failure.run.numShrinks).toBeGreaterThan(0);
    expect(told(failure)).toContain("sits in asking");
  });

  it("works through propertyTerminates too", () => {
    const failure = failureOf(() =>
      propertyTerminates(machine, ctx, lists, (s) => s.type !== "landed", {
        seed: 1,
        numRuns: 500,
      }),
    );
    expect(told(failure)).toContain('"type":"landed"');
  });
});

describe("every answer answers a Cmd really sent", () => {
  it.each(SEEDS)("on every list, seed %i", (seed) => {
    let answered = 0;
    for (const msgs of fc.sample(lists, { seed, numRuns: 1000 })) {
      const { steps, initCmds } = folded(machine, msgs);
      expect(walk(initCmds, steps).misfit).toBeNull();
      answered += steps.filter(({ msg }) => "cmd" in msg).length;
    }
    expect(answered).toBeGreaterThan(1000);
  });

  it("the machine keeps no Cmd in its state", () => {
    for (const msgs of fc.sample(lists, { seed: 1, numRuns: 200 })) {
      for (const state of folded(machine, msgs).states) {
        expect(JSON.stringify(state)).not.toMatch(
          /"type":"(lint|test|scan|publish)"/,
        );
      }
    }
  });

  it("answers a Cmd sent twice at most twice", () => {
    const twice = fc.sample(lists, { seed: 42, numRuns: 2000 }).some((msgs) => {
      const asks = folded(machine, msgs).steps.flatMap(({ cmds }) =>
        cmds.filter((cmd) => cmd.type === "lint"),
      ).length;
      const answers = msgs.filter(
        ({ type }) => type === "lint_ok" || type === "lint_err",
      ).length;
      expect(answers).toBeLessThanOrEqual(asks);
      return answers >= 2;
    });
    expect(twice).toBe(true);
  });

  it("drops an answer event with nothing waiting: no list opens on an answer", () => {
    for (const msgs of fc.sample(lists, { seed: 1, numRuns: 500 })) {
      const [first] = msgs;
      if (first !== undefined) expect(first.type).toMatch(/^(start|nudge)$/);
    }
  });

  it("never answers a Cmd type with no cell, and gets nothing from one", () => {
    const { lint: _lint, ...rest } = cells.answers;
    const partial = arbGuidedSequence(machine, ctx, {
      outside: cells.outside,
      answers: rest,
    });
    for (const msgs of fc.sample(partial, { seed: 1, numRuns: 500 })) {
      expect(msgs.some(({ type }) => type.startsWith("lint_"))).toBe(false);
    }
  });
});

const SHRINK_SEEDS = Array.from({ length: 30 }, (_, i) => 745 + i);

/**
 * Fail the "lands" law on a broken machine, and give back the list first found and
 * its shrunk form. Each list the property sees is folded, so the first failure is
 * the list found.
 */
const shrink = (
  broken: typeof machine,
  from: fc.Arbitrary<readonly Msg[]>,
  seed: number,
) => {
  let first: readonly Msg[] | null = null;
  const details = fc.check(
    fc.property(from, (msgs) => {
      const { steps, finalState, initCmds } = folded(broken, msgs);
      const held = landsGivenEveryAnswer(steps, finalState, initCmds) === true;
      if (!held) first ??= msgs;
      return held;
    }),
    { seed, numRuns: 2000 },
  );
  const [shrunk] = details.counterexample ?? [];
  if (first === null || shrunk === undefined) {
    throw new Error(`seed ${seed} found no failure`);
  }
  return { first: first as readonly Msg[], shrunk };
};

describe("a shrunk list", () => {
  it.each(
    SHRINK_SEEDS,
  )("still answers only sent Cmds, and is no longer, seed %i", (seed) => {
    const { first, shrunk } = shrink(dropsAnAnswer, lists, seed);
    const { steps, initCmds } = folded(dropsAnAnswer, shrunk);
    expect(walk(initCmds, steps).misfit).toBeNull();
    expect(shrunk.length).toBeLessThanOrEqual(first.length);
  });

  it("reaches the true shortest on nearly every seed", () => {
    // start, then one good answer per check.
    const shortest = 4;
    const lengths = SHRINK_SEEDS.map(
      (seed) => shrink(dropsAnAnswer, lists, seed).shrunk.length,
    );
    const atShortest = lengths.filter((length) => length === shortest);
    expect(Math.min(...lengths)).toBe(shortest);
    expect(atShortest.length).toBeGreaterThanOrEqual(SHRINK_SEEDS.length * 0.8);
  });

  it("shrinks a drawn value too", () => {
    // A ticket of 3 or more letters breaks this copy, so the shortest is 3 letters.
    const longTicket = release({
      ...update,
      publish_ok: (s) =>
        s.type === "publishing" && s.ticket.length >= 3
          ? [{ type: "idle" }, []]
          : update.publish_ok(s, {} as never),
    });
    const longTickets = arbGuidedSequence(longTicket, ctx, {
      ...cells,
      outside: {
        start: arbRecordMsg("start", { ticket: fc.string({ maxLength: 30 }) }),
      },
    });
    const details = fc.check(
      fc.property(longTickets, (msgs) => {
        const final = folded(longTicket, msgs).finalState;
        return !(final.type === "idle" && msgs.length > 0);
      }),
      { seed: 1, numRuns: 2000 },
    );
    const [shrunk] = details.counterexample ?? [];
    const start = shrunk?.find(
      (msg): msg is Extract<Msg, { type: "start" }> => msg.type === "start",
    );
    expect(start?.ticket).toHaveLength(3);
  });
});

describe("a machine with no machine.cmds", () => {
  // Hand-written Cmds, and answers that carry no `cmd`: nothing to read a pairing
  // from. `init` sends one too, and the cell names it by the Cmd it gets.
  type Job = { readonly type: "job"; readonly id: number };
  type Done = { readonly type: "done"; readonly id: number };
  type Go = { readonly type: "go" };
  type Bare = { readonly open: readonly number[]; readonly closed: number };

  const bare = defineMachine({
    types: {
      model: {} as Bare,
      msg: {} as Done | Go,
      cmd: {} as Job,
      ctx: {} as Ctx,
    },
    init: (loaded) => [
      loaded ?? { open: [0], closed: 0 },
      [{ type: "job", id: 0 }],
    ],
    update: {
      go: (s) => {
        const id = s.open.length + s.closed;
        return [{ ...s, open: [...s.open, id] }, [{ type: "job", id }]];
      },
      done: (s, m) => [
        {
          open: s.open.filter((id) => id !== m.id),
          closed: s.closed + 1,
        },
        [],
      ],
    } satisfies Reducer<Bare, Done | Go, Job>,
  });

  const bareLists = arbGuidedSequence(bare, ctx, {
    outside: { go: fc.constant({ type: "go" as const }) },
    answers: {
      job: {
        draw: fc.constant(null),
        make: (cmd) => ({ type: "done" as const, id: cmd.id }),
      },
    },
  });

  it("gets a waiting list of what its reducer and init sent", () => {
    expect(bare.cmds).toBeUndefined();
    let reachedInit = 0;
    for (const msgs of fc.sample(bareLists, { seed: 1, numRuns: 1000 })) {
      const { steps, finalState } = foldEvents(bare, ctx, null, msgs);
      const open = new Set([0]);
      for (const { msg, cmds } of steps) {
        if (msg.type === "done") {
          expect(open.delete(msg.id)).toBe(true);
        }
        for (const cmd of cmds) open.add(cmd.id);
      }
      expect([...open].sort()).toEqual([...finalState.open].sort());
      if (msgs[0]?.type === "done" && msgs[0].id === 0) reachedInit++;
    }
    expect(reachedInit).toBeGreaterThan(0);
  });

  it("starts from `loaded` when given one", () => {
    const loaded: Bare = { open: [], closed: 5 };
    const from = arbGuidedSequence(
      bare,
      ctx,
      {
        answers: {
          job: {
            draw: fc.constant(null),
            make: (cmd) => ({ type: "done" as const, id: cmd.id }),
          },
        },
      },
      { loaded },
    );
    // `init` resends job 0 here, as `replay` boots it, and it can be answered once.
    for (const msgs of fc.sample(from, { seed: 1, numRuns: 100 })) {
      expect(msgs.length).toBeLessThanOrEqual(1);
    }
  });
});

describe("a machine in the transitions form", () => {
  // The same release, where each state lists only the Msgs it takes. `asking` has no
  // `start`, and `publishing` has no check answer, so a check nudged twice can answer
  // after the run has left. `landed` takes nothing, whatever still waits.
  const table = {
    idle: {
      start: (_s, m) => [
        { type: "asking", ticket: m.ticket, got: [] },
        CHECKS.map((name) => ask(name, m.ticket)),
      ],
    },
    asking: {
      nudge: update.nudge,
      lint_ok: checkOk("lint"),
      lint_err: checkErr("lint"),
      test_ok: checkOk("test"),
      test_err: checkErr("test"),
      scan_ok: checkOk("scan"),
      scan_err: checkErr("scan"),
    },
    publishing: {
      publish_ok: () => [{ type: "landed" }, []],
      publish_err: (s) => [s, [publish({ ticket: s.ticket })]],
    },
    landed: {},
  } satisfies Transitions<State, Msg, Sent>;

  const phased = (cells: Transitions<State, Msg, Sent> = table) =>
    defineMachine({
      types: {
        model: {} as State,
        msg: {} as Msg,
        cmd: {} as Sent,
        ctx: {} as Ctx,
      },
      cmds: [defined.lint, defined.test, defined.scan, publish],
      init: (loaded) => [loaded ?? { type: "idle" }, []],
      update: cells,
    });

  const correct = phased();
  const phasedDropsAnAnswer = phased({
    ...table,
    asking: { ...table.asking, test_ok: (s) => [s, []] },
  });
  const phasedLists = arbGuidedSequence(correct, ctx, cells);

  it.each(SEEDS)("a law that always holds passes, seed %i", (seed) => {
    let landed = 0;
    const run = propertyTrace(
      correct,
      ctx,
      phasedLists,
      (_steps, final) => {
        if (final.type === "landed") landed++;
        return true;
      },
      { seed, numRuns: 500 },
    );
    expect(run.numRuns).toBe(500);
    expect(landed).toBeGreaterThan(25);
  });

  it.each(SEEDS)("a run given every answer lands, seed %i", (seed) => {
    propertyTrace(correct, ctx, phasedLists, landsGivenEveryAnswer, {
      seed,
      numRuns: 500,
    });
  });

  it.each(
    SEEDS,
  )("a broken copy fails on its law and no refusal, seed %i", (seed) => {
    const failure = failureOf(() =>
      propertyTrace(
        phasedDropsAnAnswer,
        ctx,
        arbGuidedSequence(phasedDropsAnAnswer, ctx, cells),
        landsGivenEveryAnswer,
        { seed, numRuns: 500 },
      ),
    );
    expect(failure.run.numShrinks).toBeGreaterThan(0);
    expect(told(failure)).toContain("sits in asking");
  });

  it.each(
    SHRINK_SEEDS,
  )("a shrunk failure still fits every state, and is no longer, seed %i", (seed) => {
    const { first, shrunk } = shrink(
      phasedDropsAnAnswer,
      arbGuidedSequence(phasedDropsAnAnswer, ctx, cells),
      seed,
    );
    // `folded` steps with `applyCell`, which throws on a refused Msg.
    const { steps, initCmds } = folded(phasedDropsAnAnswer, shrunk);
    expect(walk(initCmds, steps).misfit).toBeNull();
    expect(shrunk.length).toBeLessThanOrEqual(first.length);
  });

  it.each(
    SEEDS,
  )("no list holds a Msg its state refuses, and every answer was sent, seed %i", (seed) => {
    let nudgedPast = 0;
    for (const msgs of fc.sample(phasedLists, { seed, numRuns: 1000 })) {
      // `foldEvents` steps with `applyCell`, which throws on a refused Msg.
      const { steps, initCmds, finalState } = foldEvents(
        correct,
        ctx,
        null,
        msgs,
      );
      const { misfit, waiting } = walk(initCmds, steps);
      expect(misfit).toBeNull();
      if (
        finalState.type !== "asking" &&
        waiting.some((cmd) => (cmd as Sent).type !== "publish")
      ) {
        nudgedPast++;
      }
    }
    // Cmds really did outlive the state that takes their answer.
    expect(nudgedPast).toBeGreaterThan(0);
  });

  it("a refused answer leaves its Cmd waiting for a later one", () => {
    // One Cmd, sent at the start, whose answer `shut` refuses and `open` takes.
    type Job = { readonly type: "job" };
    type GateMsg = { readonly type: "unlock" } | { readonly type: "job_done" };
    type Gate =
      | { readonly type: "shut" }
      | { readonly type: "open" }
      | { readonly type: "done" };
    const gate = defineMachine({
      types: {
        model: {} as Gate,
        msg: {} as GateMsg,
        cmd: {} as Job,
        ctx: {} as Ctx,
      },
      init: (loaded) => [loaded ?? { type: "shut" }, [{ type: "job" }]],
      update: {
        shut: { unlock: () => [{ type: "open" }, []] },
        open: { job_done: () => [{ type: "done" }, []] },
        done: {},
      } satisfies Transitions<Gate, GateMsg, Job>,
    });

    // `make` runs for every answer event read, refused or not, so more than one call
    // on a list means a refused event left the one Cmd there to be read again.
    let reads = 0;
    const counted = arbGuidedSequence(gate, ctx, {
      outside: { unlock: fc.constant({ type: "unlock" as const }) },
      answers: {
        job: {
          draw: fc.constant(null),
          make: () => {
            reads++;
            return { type: "job_done" as const };
          },
        },
      },
    }).map((msgs) => {
      const read = reads;
      reads = 0;
      return { msgs, read };
    });

    const samples = fc.sample(counted, { seed: 1, numRuns: 500 });
    expect(
      samples.some(
        ({ msgs, read }) =>
          read > 1 && msgs.some(({ type }) => type === "job_done"),
      ),
    ).toBe(true);
    for (const { msgs } of samples) {
      expect(
        msgs.filter(({ type }) => type === "job_done").length,
      ).toBeLessThanOrEqual(1);
      expect(foldEvents(gate, ctx, null, msgs).steps).toHaveLength(msgs.length);
    }
  });

  it("a step's throw is still that list's failure, not a dropped event", () => {
    const throwing = phased({
      ...table,
      asking: {
        ...table.asking,
        scan_ok: () => {
          throw new Error("scan_ok broke");
        },
      },
    });
    const failure = failureOf(() =>
      propertyTrace(
        throwing,
        ctx,
        arbGuidedSequence(throwing, ctx, cells),
        () => true,
        { seed: 1, numRuns: 500 },
      ),
    );
    expect(told(failure)).toContain("scan_ok broke");
    expect(failure.message).toMatch(/"type":"scan_ok"[^\]]*\]\]/);
  });
});

describe("what goes wrong", () => {
  it("a reducer's throw comes back as that list's failure, ending on the Msg", () => {
    const throwing = release({
      ...update,
      scan_ok: () => {
        throw new Error("scan_ok broke");
      },
    });
    const failure = failureOf(() =>
      propertyTrace(
        throwing,
        ctx,
        arbGuidedSequence(throwing, ctx, cells),
        () => true,
        { seed: 1, numRuns: 500 },
      ),
    );
    expect(told(failure)).toContain("scan_ok broke");
    expect(failure.run.numShrinks).toBeGreaterThan(0);
    expect(failure.message).toMatch(/"type":"scan_ok"[^\]]*\]\]/);
  });

  it("an init's throw comes back as a failure on an empty list", () => {
    const throwing = defineMachine({
      types: {
        model: {} as State,
        msg: {} as Msg,
        cmd: {} as Sent,
        ctx: {} as Ctx,
      },
      cmds: [defined.lint, defined.test, defined.scan, publish],
      init: () => {
        throw new Error("init broke");
      },
      update,
    });
    const failure = failureOf(() =>
      propertyTrace(
        throwing,
        ctx,
        arbGuidedSequence(throwing, ctx, cells),
        () => true,
        { seed: 1, numRuns: 10 },
      ),
    );
    expect(told(failure)).toContain("init broke");
  });

  it("a cell's own throw is not hidden as a short list", () => {
    const badCell = arbGuidedSequence(machine, ctx, {
      outside: { start: startCell },
      answers: {
        lint: {
          draw: fc.constant(null),
          make: () => {
            throw new Error("make broke");
          },
        },
      },
    });
    expect(() => fc.sample(badCell, { seed: 1, numRuns: 100 })).toThrow(
      "make broke",
    );
  });

  it("no cells at all is refused, not a stream of empty lists", () => {
    expect(() => arbGuidedSequence(machine, ctx, {})).toThrow(/no cells/);
  });

  it("a cmds list that names one Cmd twice is refused, as run and drive refuse it", () => {
    // The answers come from the cells' keys, so this entry would answer right; it
    // refuses the list anyway, so one rule holds on every property-test entry.
    const lintAgain = Cmd.define("lint", {
      input,
      ok: z.string(),
      err: ["flaky"],
    });
    const listed = [defined.lint, defined.test, defined.scan, publish];
    for (const cmds of [
      [...listed, lintAgain],
      [...listed, defined.lint],
    ]) {
      let error: unknown;
      try {
        arbGuidedSequence({ ...machine, cmds }, ctx, cells);
      } catch (thrown) {
        error = thrown;
      }
      expect(error).toBeInstanceOf(CmdNameCollisionError);
      expect(error).toMatchObject({ cmdType: "lint" });
    }
  });

  it("a Cmd type named after an Object.prototype key has no cell", () => {
    type Odd = { readonly type: "constructor" };
    const odd = defineMachine({
      types: {
        model: {} as { readonly sent: number },
        msg: {} as { readonly type: "send" } | { readonly type: "got" },
        cmd: {} as Odd,
        ctx: {} as Ctx,
      },
      init: () => [{ sent: 0 }, []],
      update: {
        send: (s) => [{ sent: s.sent + 1 }, [{ type: "constructor" }]],
        got: (s) => [s, []],
      },
    });
    const sends = arbGuidedSequence(odd, ctx, {
      outside: { send: fc.constant({ type: "send" as const }) },
    });
    for (const msgs of fc.sample(sends, { seed: 1, numRuns: 50 })) {
      expect(msgs.every(({ type }) => type === "send")).toBe(true);
    }
  });
});

describe("the cell's types", () => {
  it("are checked by the compiler", () => {
    // `typecheck:test` is what fails here. Nothing calls this: some cells are wrong.
    const _never = () => {
      arbGuidedSequence(machine, ctx, {
        answers: {
          publish: {
            draw: fc.string(),
            // `cmd` is the Cmd of this type, and `value` is what `draw` draws.
            make: (cmd, value) => {
              const ticket: string = cmd.ticket;
              const sha: string = value;
              return publish.ok(cmd, `${ticket}${sha}`);
            },
          },
        },
      });

      arbGuidedSequence(machine, ctx, {
        outside: {
          // @ts-expect-error A cell by state and waiting is not a cell: the ruling chose
          // `{ draw, make }`, because a cell that reads the state cannot shrink its value.
          start: (_state: State, _waiting: readonly Sent[]) => startCell,
        },
      });

      arbGuidedSequence(machine, ctx, {
        answers: {
          lint: {
            draw: fc.string(),
            // @ts-expect-error `make` takes what `draw` draws.
            make: (cmd, value: number) =>
              defined.lint.err(cmd, { _tag: "flaky", value }) as Msg,
          },
        },
      });

      arbGuidedSequence(machine, ctx, {
        answers: {
          // @ts-expect-error No Cmd has this type.
          nothing: { draw: fc.constant(null), make: () => ({ type: "nudge" }) },
        },
      });

      arbGuidedSequence(machine, ctx, {
        outside: {
          // @ts-expect-error No Msg has this type.
          nothing: fc.constant({ type: "nothing" }),
        },
      });
    };
    expect(_never).toBeTypeOf("function");
  });
});
