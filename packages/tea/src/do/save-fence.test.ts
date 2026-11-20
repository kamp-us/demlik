/// <reference types="@cloudflare/workers-types" />
/**
 * A save the engine gave up on never overwrites a later run (ADR 0025, #989).
 *
 * `save-fence.ts` is one state × event table. The first describe walks that
 * table cell by cell, so a cell with no expectation fails to compile and a cell
 * with no test fails the count. The second drives real runs on one storage with
 * `disposeTimeoutMs: 0`, the repro: the stopped run's save is held at its write
 * point, a later run loads and saves, and the held save is let go. Each path
 * names the cells it walks, ten times over.
 */

import { describe, expect, it } from "vitest";
import { fakeDoStorage } from "../__fixtures__/do-storage";
import {
  defineMachine,
  type Reducer,
  type RuntimeErrorContext,
  StoreConflictError,
} from "../index";
import { run } from "../promise";
import { doEventSourcedStore } from "./event-sourced-store";
import {
  SAVE_FENCE,
  type SaveCmd,
  type SaveEvent,
  type SavePhase,
  stepSave,
} from "./save-fence";

type PhaseTag = SavePhase["_tag"];
type EventTag = SaveEvent["_tag"];
type CmdTag = SaveCmd["_tag"];

const PHASES = ["issued", "superseded", "admitted", "refused"] as const;
const EVENTS = ["takeOver", "reach"] as const;

/** Every cell's answer: the phase it moves to and the Cmds it owes. */
const EXPECTED = {
  issued: {
    takeOver: ["superseded", []],
    reach: ["admitted", ["write"]],
  },
  superseded: {
    takeOver: ["superseded", []],
    reach: ["refused", ["refuse"]],
  },
  admitted: {
    takeOver: ["admitted", []],
    reach: ["admitted", []],
  },
  refused: {
    takeOver: ["refused", []],
    reach: ["refused", []],
  },
} satisfies Record<
  PhaseTag,
  Record<EventTag, readonly [PhaseTag, readonly CmdTag[]]>
>;

const cells = Object.entries(SAVE_FENCE).flatMap(([phase, row]) =>
  Object.keys(row).map((event): [PhaseTag, EventTag] => [
    phase as PhaseTag,
    event as EventTag,
  ]),
);

describe("the save table: one test for each cell", () => {
  it("has exactly the cells the expectations name", () => {
    expect(cells).toHaveLength(PHASES.length * EVENTS.length);
    expect(Object.keys(SAVE_FENCE).sort()).toEqual([...PHASES].sort());
    for (const phase of PHASES) {
      expect(Object.keys(SAVE_FENCE[phase]).sort()).toEqual([...EVENTS].sort());
    }
  });

  it.each(cells)("%s × %s", (phase, event) => {
    const [next, cmds] = stepSave({ _tag: phase }, { _tag: event });
    const [nextTag, cmdTags] = EXPECTED[phase][event];
    expect(next._tag).toBe(nextTag);
    expect(cmds.map((cmd) => cmd._tag)).toEqual(cmdTags);
  });
});

// A counter that takes a number, so a save that lands over another shows in the
// State: two runs that both `ask` by 1 would hide which one wrote last.
interface Model {
  readonly total: number;
}
type Msg = { readonly _tag: "ask"; readonly by: number };

const update: Reducer<Model, Msg, never> = {
  ask: (s, m) => [{ total: s.total + m.by }, []],
};

const machine = defineMachine({
  types: {
    model: {} as Model,
    msg: {} as Msg,
    ctx: {} as Record<string, never>,
  },
  init: (loaded) => [loaded ?? { total: 0 }, []],
  update,
});
const ctx: Record<string, never> = {};

const REPEATS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const SETTLE_MS = 20;

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
const until = async (holds: () => boolean) => {
  while (!holds()) await new Promise((resolve) => setTimeout(resolve, 1));
};

/**
 * One DO storage in one isolate. `holdNext()` makes the next storage
 * transaction wait, which is where a save waits when an earlier write is still
 * under way: the write point is inside the transaction, after the wait.
 */
function oneStorage() {
  const fake = fakeDoStorage();
  let waiting: Promise<void> | null = null;
  let entered = 0;
  const storage = Object.assign(Object.create(fake.storage), {
    async transaction<T>(
      closure: (txn: DurableObjectTransaction) => Promise<T>,
    ): Promise<T> {
      entered++;
      const wait = waiting;
      waiting = null;
      if (wait !== null) await wait;
      return fake.storage.transaction(closure);
    },
  }) as typeof fake.storage;
  return {
    storage,
    backing: fake.backing,
    entered: () => entered,
    holdNext(): () => void {
      let release: () => void = () => undefined;
      waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}
type OneStorage = ReturnType<typeof oneStorage>;

/** What a run was told through `onError`. */
interface Told {
  readonly error: unknown;
  readonly phase: string;
}

/** A run whose store is built on `held.storage`: loaded, so it holds the log. */
async function activate(
  held: OneStorage,
  reuse?: ReturnType<typeof doEventSourcedStore<Model, Msg, typeof ctx>>,
) {
  const told: Told[] = [];
  const es = reuse ?? doEventSourcedStore(held.storage, machine, ctx);
  const booted = run(machine, {
    ctx,
    store: es.store,
    disposeTimeoutMs: 0,
    onError: (error: unknown, context: RuntimeErrorContext) => {
      told.push({ error, phase: context.phase });
    },
  });
  const runtime = await booted.ready;
  return { es, runtime, told, stop: () => booted.stop() };
}
type Activation = Awaited<ReturnType<typeof activate>>;

/** What a fresh activation reads from the log. This loads, so it takes the log. */
async function foldedTotal(held: OneStorage): Promise<number> {
  const run = await activate(held);
  const total = run.runtime.getState().total;
  await run.stop();
  return total;
}

/**
 * A booted run whose step save is held at its write point, then stopped with
 * `disposeTimeoutMs: 0`: `stop()` returns while the save is still waiting.
 * `asked` settles with the dispatch's failure, or with nothing.
 */
async function stoppedWithSaveHeld(held: OneStorage, by: number) {
  const first = await activate(held);
  const release = held.holdNext();
  const before = held.entered();
  const asked = first.runtime.dispatchOnce({ _tag: "ask", by }).then(
    () => undefined,
    (error: unknown) => error,
  );
  await until(() => held.entered() === before + 1);
  await first.stop();
  return { first, asked, release };
}

/** A later run loads the log and saves two steps of its own, 1 and 2. */
async function laterRunSaves(
  held: OneStorage,
  startedAt = 0,
): Promise<Activation> {
  const later = await activate(held);
  expect(later.runtime.getState().total).toBe(startedAt);
  await later.runtime.dispatchOnce({ _tag: "ask", by: 1 });
  await later.runtime.dispatchOnce({ _tag: "ask", by: 2 });
  expect(later.runtime.getState().total).toBe(startedAt + 3);
  return later;
}

const STALE = 100;

/**
 * Every path through the save table, with the cells it walks. A cell that no
 * path walks must be in `NEVER_IN_A_RUN`, with the reason.
 */
const PATHS: readonly {
  readonly name: string;
  readonly cells: readonly (readonly [PhaseTag, EventTag])[];
  readonly check: () => Promise<void>;
}[] = [
  {
    name: "a save the run gave up on, with no later run, still lands",
    cells: [["issued", "reach"]],
    async check() {
      const held = oneStorage();
      const { first, asked, release } = await stoppedWithSaveHeld(held, 5);
      release();
      expect(await asked).toBeUndefined();
      await settle();
      expect(first.told.map((t) => t.phase)).toContain("discard");
      expect(await foldedTotal(held)).toBe(5);
    },
  },
  {
    name: "a later run loads and saves, and the held save is refused when it lands",
    cells: [
      ["issued", "takeOver"],
      ["superseded", "reach"],
      ["refused", "takeOver"],
    ],
    async check() {
      const held = oneStorage();
      const { asked, release } = await stoppedWithSaveHeld(held, STALE);
      const later = await laterRunSaves(held);

      release();
      expect(await asked).toBeInstanceOf(StoreConflictError);
      await settle();
      expect(await later.es.store.load()).toEqual({ total: 3 });

      await later.stop();
      expect(await foldedTotal(held)).toBe(3);
    },
  },
  {
    name: "a second later run loads before the held save lands, and it is still refused",
    cells: [["superseded", "takeOver"]],
    async check() {
      const held = oneStorage();
      const { asked, release } = await stoppedWithSaveHeld(held, STALE);
      const later = await laterRunSaves(held);
      await later.stop();
      const third = await activate(held);
      expect(third.runtime.getState().total).toBe(3);

      release();
      expect(await asked).toBeInstanceOf(StoreConflictError);
      await settle();
      await third.stop();
      expect(await foldedTotal(held)).toBe(3);
    },
  },
  {
    name: "a save that landed is part of what a later run loads",
    cells: [["admitted", "takeOver"]],
    async check() {
      const held = oneStorage();
      const first = await activate(held);
      await first.runtime.dispatchOnce({ _tag: "ask", by: 4 });
      await first.stop();
      const later = await activate(held);
      expect(later.runtime.getState().total).toBe(4);
      await later.stop();
      expect(first.told).toEqual([]);
    },
  },
  {
    name: "the same store handed to a later run, as a host that rebuilds its run does, refuses it too",
    cells: [
      ["issued", "takeOver"],
      ["superseded", "reach"],
    ],
    async check() {
      const held = oneStorage();
      const { first, asked, release } = await stoppedWithSaveHeld(held, STALE);
      const later = await activate(held, first.es);
      // The reused store writes one event at a time, so the later run's first
      // step waits behind the held save, which is refused when it lands.
      const stepped = later.runtime.dispatchOnce({ _tag: "ask", by: 1 });
      release();
      expect(await asked).toBeInstanceOf(StoreConflictError);
      await stepped;
      await later.runtime.dispatchOnce({ _tag: "ask", by: 2 });
      await settle();
      expect(await later.es.store.load()).toEqual({ total: 3 });
      await later.stop();
      expect(await foldedTotal(held)).toBe(3);
    },
  },
  {
    name: "a snapshot from a stopped run is refused the same way",
    cells: [["superseded", "reach"]],
    async check() {
      const held = oneStorage();
      const first = await activate(held);
      await first.runtime.dispatchOnce({ _tag: "ask", by: STALE });
      const release = held.holdNext();
      const before = held.entered();
      const snapshotted = first.es.snapshotNow().then(
        () => undefined,
        (error: unknown) => error,
      );
      await until(() => held.entered() === before + 1);
      await first.stop();
      const later = await laterRunSaves(held, STALE);

      release();
      expect(await snapshotted).toBeInstanceOf(StoreConflictError);
      await settle();
      expect(held.backing.has("@@es/snapshot")).toBe(false);
      expect(await later.es.store.load()).toEqual({ total: STALE + 3 });
      await later.stop();
    },
  },
];

/** Cells no run reaches: a save reaches its write point once. */
const NEVER_IN_A_RUN: readonly (readonly [PhaseTag, EventTag])[] = [
  ["admitted", "reach"],
  ["refused", "reach"],
];

describe("a save abandoned at dispose, on a log a later run took over (disposeTimeoutMs: 0)", () => {
  it("names every cell of the table, in a path or as one a run never reaches", () => {
    const named = new Set(
      [...PATHS.flatMap((path) => path.cells), ...NEVER_IN_A_RUN].map(
        ([phase, event]) => `${phase} × ${event}`,
      ),
    );
    expect([...named].sort()).toEqual(
      cells.map(([phase, event]) => `${phase} × ${event}`).sort(),
    );
  });

  describe.each(PATHS)("$name", ({ check }) => {
    it.each(REPEATS)("repeat %i", async () => {
      await check();
    });
  });
});
