// ═══════════════════════════════════════════════════════════════════════════
// THE THREE AUTHORING MISTAKES A RUN CAN MAKE THAT A DRAWING CANNOT.
//
// A type-only file, exactly as `markers.test-d.ts` is: `tsconfig.json` excludes
// `*.test.ts` from the shipped build and `tsconfig.test.json` puts this back,
// so `pnpm typecheck:test` IS the assertion.
//
// Each rule is asserted twice, and the pair is the point — the MARKER is
// produced (so the diagnostic names the offender), and the CONSTRAINT bites (so
// `runLane` actually rejects the call). A marker nothing referenced would pass
// the first and silently lose the second.
// ═══════════════════════════════════════════════════════════════════════════
import { defineChart, ty } from "../graph";
import { coderParts, epic } from "./__fixtures__/epic-run";
import { type LaneRunChecks, runLane } from "./run";
import { defineLane } from "./structure";

type Marks<H, K extends string> =
  LaneRunChecks<typeof epic, H> extends Record<K, unknown> ? true : false;
type Clean<L, H> =
  LaneRunChecks<L, H> extends Record<`__${string}`, unknown> ? false : true;
type Expect<T extends true> = T;

const queued = () => ({ type: "queued", retries: 0, maxRetries: 2 }) as const;
const landed = () => ({ type: "landed", retries: 0, maxRetries: 2 }) as const;

// ── the hands that are FINE, so the checks are not vacuously true ──────────
type Good = {
  readonly issue_1: { readonly boot: typeof queued };
  readonly issue_2: { readonly boot: typeof queued };
  readonly issue_3: { readonly boot: typeof queued };
};
export type _good = Expect<Clean<typeof epic, Good>>;

runLane(epic, {
  issue_1: { parts: coderParts, boot: queued },
  issue_2: { parts: coderParts, boot: queued },
  issue_3: { parts: coderParts, boot: queued },
});

// ── 1. an instance booted into a state its OWN chart never declares ────────
//
// The mistake the per-instance boot introduces. A lane boots each child where
// its sub-issue actually is, so the boot state is data — and data that names a
// state the chart does not have is a region that can never take an edge, in a
// phase that can therefore never complete.
type BadBoot = {
  readonly issue_1: { readonly boot: typeof landed };
  readonly issue_2: { readonly boot: typeof queued };
  readonly issue_3: { readonly boot: typeof queued };
};
export type _badBoot = Expect<
  Marks<BadBoot, "__laneTaskBootsIntoAStateItsChartDoesNotDeclare">
>;

runLane(epic, {
  // @ts-expect-error — `landed` is not a state of `issue_1`'s chart
  issue_1: { parts: coderParts, boot: landed },
  issue_2: { parts: coderParts, boot: queued },
  issue_3: { parts: coderParts, boot: queued },
});

// ── 2. a hand for a task the lane does not declare ────────────────────────
//
// Silently ignored otherwise: the parts and the boot state an author wrote for
// `issue_9` would simply never be reached, and the lane would run with the
// three regions it does have while the author believed there were four.
type Stranger = {
  readonly issue_1: { readonly boot: typeof queued };
  readonly issue_2: { readonly boot: typeof queued };
  readonly issue_3: { readonly boot: typeof queued };
  readonly issue_9: { readonly boot: typeof queued };
};
export type _stranger = Expect<Marks<Stranger, "__laneHandNamesAnUnknownTask">>;

runLane(epic, {
  issue_1: { parts: coderParts, boot: queued },
  issue_2: { parts: coderParts, boot: queued },
  issue_3: { parts: coderParts, boot: queued },
  // @ts-expect-error — no task is called `issue_9`
  issue_9: { parts: coderParts, boot: queued },
});

// ── 3. a region whose chart declares a FOREIGN event ──────────────────────
//
// `keyOf` leaves a foreign event BARE under a namespace, deliberately: it is
// the same event for every instance of the chart. A lane message is addressed
// to one region, so a bare event addresses none of them — the routing has no
// answer, and inventing one (broadcast) would be a different machine than the
// phases describe.
const listening = defineChart({
  events: {
    GO: { scope: "edges" },
    deadline_exceeded: {
      data: ty<{ readonly atMs: number }>(),
      scope: "edges",
      foreign: true,
    },
  },
  states: {
    only: {
      queued: { initial: true, on: { GO: "shipped" } },
      shipped: { end: true },
    },
  },
});

const listener = defineLane({
  phases: { p1: { t1: listening } },
  terminals: { complete: "complete", tripped: "tripped" },
});

type Foreign = {
  readonly t1: { readonly boot: () => { readonly type: "queued" } };
};
export type _foreign =
  LaneRunChecks<typeof listener, Foreign> extends Record<
    "__laneRegionChartDeclaresAForeignEvent",
    unknown
  >
    ? true
    : false;
export type _foreignMarks = Expect<_foreign>;

// @ts-expect-error — `t1`'s chart declares `deadline_exceeded` foreign
runLane(listener, {
  t1: {
    parts: { assign: { "queued.GO": () => ({}) } },
    boot: () => ({ type: "queued" }) as const,
  },
});
