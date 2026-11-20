/**
 * The agent host's lifecycle table, one case list per (phase × message) cell. A
 * refused overlap is a cell too: its case asserts the `refuse` Cmd the
 * interpreter throws as a `HostOverlapError`.
 * `CELLS` is typed over every phase and every message, so a cell the table
 * gains without a case here is a compile error, not a reviewer's find.
 *
 * Globals are NOT enabled in vitest.config.ts — describe/it/expect are imported.
 */
import { describe, expect, it } from "vitest";
import {
  type Deferred,
  deferred,
  type HostMsg,
  type HostPhase,
  hostLifecycle,
  stepLifecycle,
} from "./host-lifecycle";

interface Record_ {
  readonly id: string;
  readonly handle: unknown;
}
type Phase = HostPhase<Record_>;
type Msg = HostMsg<Record_>;

const REPEATS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

interface World {
  readonly a: Record_;
  readonly b: Record_;
  readonly inRun: Record_;
  readonly fresh: Record_;
  readonly done: Deferred<void>;
}

const world = (): World => ({
  a: { id: "a", handle: {} },
  b: { id: "b", handle: {} },
  inRun: { id: "inRun", handle: null },
  fresh: { id: "fresh", handle: null },
  done: deferred(),
});

interface Case {
  readonly name: string;
  readonly phase: (w: World) => Phase;
  readonly msg: (w: World) => Msg;
  readonly next: (w: World) => Phase;
  readonly cmds: (w: World) => readonly unknown[];
}

const empty: Phase = { _tag: "empty" };
const tearing: Phase = { _tag: "tearingDown" };
const runtime = (w: World): Msg => ({ _tag: "runtime", fresh: w.fresh });
const reset = (w: World): Msg => ({ _tag: "reset", done: w.done });
const tornDown = (): Msg => ({ _tag: "tornDown" });
const building = (w: World): Phase => ({ _tag: "building", build: w.a });
const buildingInRun = (w: World): Phase => ({
  _tag: "building",
  build: w.inRun,
});
const live = (w: World): Phase => ({ _tag: "live", build: w.a });
const none = () => [];

const unchanged = (phase: (w: World) => Phase, msg: (w: World) => Msg) =>
  ({ name: "changes nothing", phase, msg, next: phase, cmds: none }) as const;

const refused = (
  phase: (w: World) => Phase,
  msg: (w: World) => Msg,
  call: "reset" | "runtime",
  during: "teardown" | "run",
) =>
  ({
    name: `refuses: ${call}() during ${during}`,
    phase,
    msg,
    next: phase,
    cmds: () => [{ _tag: "refuse", call, during }],
  }) as const;

const CELLS = {
  empty: {
    runtime: [
      {
        name: "starts a build from the offered record",
        phase: () => empty,
        msg: runtime,
        next: (w) => ({ _tag: "building", build: w.fresh }),
        cmds: (w) => [{ _tag: "begin", build: w.fresh }],
      },
    ],
    reset: [unchanged(() => empty, reset)],
    built: [
      unchanged(
        () => empty,
        (w) => ({ _tag: "built", build: w.a }),
      ),
    ],
    failed: [
      unchanged(
        () => empty,
        (w) => ({ _tag: "failed", build: w.a }),
      ),
    ],
    tornDown: [unchanged(() => empty, tornDown)],
  },
  building: {
    runtime: [unchanged(building, runtime)],
    reset: [
      {
        name: "tears the build down once run has returned its handle",
        phase: building,
        msg: reset,
        next: () => tearing,
        cmds: (w) => [{ _tag: "tearDown", build: w.a, done: w.done }],
      },
      refused(buildingInRun, reset, "reset", "run"),
    ],
    built: [
      {
        name: "goes live when its own build settles",
        phase: building,
        msg: (w) => ({ _tag: "built", build: w.a }),
        next: (w) => ({ _tag: "live", build: w.a }),
        cmds: none,
      },
      {
        ...unchanged(building, (w) => ({ _tag: "built", build: w.b })),
        name: "ignores another build settling",
      },
    ],
    failed: [
      {
        name: "empties when its own build fails",
        phase: building,
        msg: (w) => ({ _tag: "failed", build: w.a }),
        next: () => empty,
        cmds: none,
      },
      {
        ...unchanged(building, (w) => ({ _tag: "failed", build: w.b })),
        name: "ignores another build failing",
      },
    ],
    tornDown: [unchanged(building, tornDown)],
  },
  live: {
    runtime: [unchanged(live, runtime)],
    reset: [
      {
        name: "tears the live build down",
        phase: live,
        msg: reset,
        next: () => tearing,
        cmds: (w) => [{ _tag: "tearDown", build: w.a, done: w.done }],
      },
    ],
    built: [unchanged(live, (w) => ({ _tag: "built", build: w.b }))],
    failed: [unchanged(live, (w) => ({ _tag: "failed", build: w.b }))],
    tornDown: [unchanged(live, tornDown)],
  },
  tearingDown: {
    runtime: [refused(() => tearing, runtime, "runtime", "teardown")],
    reset: [refused(() => tearing, reset, "reset", "teardown")],
    built: [
      unchanged(
        () => tearing,
        (w) => ({ _tag: "built", build: w.a }),
      ),
    ],
    failed: [
      unchanged(
        () => tearing,
        (w) => ({ _tag: "failed", build: w.a }),
      ),
    ],
    tornDown: [
      {
        name: "empties once the teardown settles",
        phase: () => tearing,
        msg: tornDown,
        next: () => empty,
        cmds: none,
      },
    ],
  },
} satisfies {
  readonly [P in Phase["_tag"]]: {
    readonly [K in Msg["_tag"]]: readonly [Case, ...Case[]];
  };
};

// Every record and deferred in a step is compared by identity: each is
// replaced by its name in the world, so a cell that keeps the wrong one fails.
const label = (w: World) => {
  const names = new Map<unknown, string>(
    Object.entries(w).map(([name, value]) => [value, name]),
  );
  const walk = (value: unknown): unknown => {
    const name = names.get(value);
    if (name !== undefined) return name;
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [key, walk(inner)]),
      );
    return value;
  };
  return walk;
};

const cells = Object.entries(CELLS).flatMap(([phase, row]) =>
  Object.entries(row).flatMap(([msg, cases]) =>
    cases.map((c: Case) => [`${phase} × ${msg}: ${c.name}`, c] as const),
  ),
);

describe.each(cells)("host lifecycle cell %s", (_name, c) => {
  it.each(REPEATS)("steps as the table says (repeat %i)", () => {
    const w = world();
    const [next, cmds] = stepLifecycle(
      hostLifecycle<Record_>(),
      c.phase(w),
      c.msg(w),
    );
    const named = label(w);
    expect(named(next)).toStrictEqual(named(c.next(w)));
    expect(named(cmds)).toStrictEqual(named(c.cmds(w)));
  });
});
