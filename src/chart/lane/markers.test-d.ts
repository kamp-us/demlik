// ═══════════════════════════════════════════════════════════════════════════
// THE SEVEN AUTHORING MISTAKES THE TYPE LAYER CAN SEE.
//
// A type-only file. `tsconfig.json` excludes `*.test.ts` from the shipped
// build and `tsconfig.test.json` puts this back, so `pnpm typecheck:test` IS
// the assertion — vitest never runs it and there is nothing to run.
//
// Each rule is asserted twice, and the pair is the point:
//
//   the MARKER is produced — `LaneChecks` maps the offending shape to an object
//   naming the offender, so the diagnostic says which rule was broken rather
//   than handing back a `never` to reverse-engineer;
//
//   the CONSTRAINT bites — `defineLane` actually rejects the literal, which is
//   the part a marker type that nothing referenced would silently lose.
//
// Four are about the LANE's own shape and hold at either door. Three are about
// the charts it was handed, and those hold only where the chart can be asked:
// an `ImportedChart` is runtime-typed by construction (its states ARE `string`),
// so each of the three stands down at that door and `defineLane`'s runtime check
// catches it there instead — `lane.test.ts` pins that half. The pairing is the
// whole design: the typed door refuses at compile time what the imported door
// can only throw for.
// ═══════════════════════════════════════════════════════════════════════════
import { defineChart } from "../graph";
import type { ImportedChart } from "../report/workflow";
import { defineLane, type LaneChecks } from "./structure";

declare const chart: ImportedChart;

type Marks<S, K extends string> =
  LaneChecks<S> extends Record<K, unknown> ? true : false;
type Clean<S> =
  LaneChecks<S> extends Record<`__${string}`, unknown> ? false : true;
type Expect<T extends true> = T;

const OK = { complete: "complete", tripped: "tripped" } as const;
type OkTerminals = typeof OK;

// ── the shape that is FINE, so the checks are not vacuously true ───────────
type Good = {
  readonly phases: {
    readonly phase1: { readonly issue_1: ImportedChart };
    readonly phase2: { readonly issue_2: ImportedChart };
  };
  readonly terminals: OkTerminals;
  readonly retries: { readonly issue_1: number };
};
export type _good = Expect<Clean<Good>>;

defineLane({
  phases: { phase1: { issue_1: chart }, phase2: { issue_2: chart } },
  terminals: OK,
  retries: { issue_1: 3 },
});

// ── 1. a task declared in two phases ──────────────────────────────────────
//
// A task is ONE region in ONE phase. Declared twice, the later declaration
// silently wins the `charts` lookup and the earlier phase waits forever on a
// region whose state belongs to somebody else.
type Duped = {
  readonly phases: {
    readonly phase1: { readonly issue_1: ImportedChart };
    readonly phase2: { readonly issue_1: ImportedChart };
  };
  readonly terminals: OkTerminals;
};
export type _duped = Expect<Marks<Duped, "__taskDeclaredInTwoPhases">>;

// @ts-expect-error — `issue_1` is declared under both `phase1` and `phase2`
defineLane({
  phases: { phase1: { issue_1: chart }, phase2: { issue_1: chart } },
  terminals: OK,
});

// ── 2. a phase with no tasks ──────────────────────────────────────────────
//
// "Every region has reached a final" is vacuously true of no regions, so an
// empty phase completes the instant the lane reaches it — a step that exists in
// the drawing and never in the run.
type Empty = {
  readonly phases: {
    readonly phase1: { readonly issue_1: ImportedChart };
    readonly phase2: Record<never, ImportedChart>;
  };
  readonly terminals: OkTerminals;
};
export type _empty = Expect<Marks<Empty, "__phaseDeclaresNoTasks">>;

// @ts-expect-error — `phase2` declares no task, so it completes on arrival
defineLane({
  phases: { phase1: { issue_1: chart }, phase2: {} },
  terminals: OK,
});

// ── 3. a terminal that collides with a phase name ─────────────────────────
//
// The compound state value is keyed by phase name and collapses to the TERMINAL
// name when the lane ends. Spell them the same and the two readings of one key
// are indistinguishable.
type Collides = {
  readonly phases: { readonly done: { readonly issue_1: ImportedChart } };
  readonly terminals: {
    readonly complete: "done";
    readonly tripped: "tripped";
  };
};
export type _collides = Expect<Marks<Collides, "__terminalCollidesWithAPhase">>;

// @ts-expect-error — `done` is both a phase and the `complete` terminal
defineLane({
  phases: { done: { issue_1: chart } },
  terminals: { complete: "done", tripped: "tripped" },
});

// ── 4. a retry budget for a task that does not exist ──────────────────────
//
// The budget is the ONE supplied fact on the spec, which is exactly why a typo
// in it has to be caught: it is silently defaulted otherwise, and the lane
// freezes a round earlier or later than its author believes.
type Typo = {
  readonly phases: { readonly phase1: { readonly issue_1: ImportedChart } };
  readonly terminals: OkTerminals;
  readonly retries: { readonly issue_2: number };
};
export type _typo = Expect<Marks<Typo, "__retryBudgetNamesAnUnknownTask">>;

// @ts-expect-error — no task is called `issue_2`
defineLane({
  phases: { phase1: { issue_1: chart } },
  terminals: OK,
  retries: { issue_2: 3 },
});

// ── 5. a region that delegates a transition to a cell ─────────────────────
//
// `{ to, cell }` declares the reachable SET and leaves the pick to hand-written
// code. Nothing in `chart/lane` runs a cell and the lowered representation the
// fold reads holds ONE target per edge, so a lane cannot hold that edge — it
// would be a topology nobody can draw and a log nobody can replay.
const picky = defineChart({
  events: { GO: { scope: "edges" }, DONE: { scope: "edges" } },
  states: {
    only: {
      queued: { initial: true, on: { GO: { to: ["build"], cell: "pick" } } },
      build: { on: { DONE: "shipped" } },
      shipped: { end: true },
    },
  },
});
type Celled = {
  readonly phases: { readonly phase1: { readonly issue_1: typeof picky } };
  readonly terminals: OkTerminals;
};
export type _cell = Expect<Marks<Celled, "__laneTaskChartDelegatesToACell">>;

// @ts-expect-error — `issue_1`'s chart picks its target in a cell
defineLane({ phases: { phase1: { issue_1: picky } }, terminals: OK });

// ── 6. a region whose chart marks no initial state ────────────────────────
//
// The fold has no zero to start from. A runtime refusal at the imported door,
// and now a compile-time one wherever the chart is a literal.
const noStart = defineChart({
  events: { GO: { scope: "edges" } },
  states: {
    only: { queued: { on: { GO: "shipped" } }, shipped: { end: true } },
  },
});
type Startless = {
  readonly phases: { readonly phase1: { readonly issue_1: typeof noStart } };
  readonly terminals: OkTerminals;
};
export type _noInitial = Expect<
  Marks<Startless, "__laneTaskChartMarksNoInitialState">
>;

// @ts-expect-error — `issue_1`'s chart marks no `initial: true`
defineLane({ phases: { phase1: { issue_1: noStart } }, terminals: OK });

// ── 7. a region whose chart declares no final ─────────────────────────────
//
// A phase completes when every region in it reaches a final. This one never
// does, so the phase never completes and the lane never advances past it.
const endless = defineChart({
  events: { GO: { scope: "edges" }, BACK: { scope: "edges" } },
  states: {
    only: {
      queued: { initial: true, on: { GO: "build" } },
      build: { on: { BACK: "queued" } },
    },
  },
});
type Finalless = {
  readonly phases: { readonly phase1: { readonly issue_1: typeof endless } };
  readonly terminals: OkTerminals;
};
export type _noFinal = Expect<
  Marks<Finalless, "__laneTaskChartDeclaresNoFinal">
>;

// @ts-expect-error — `issue_1`'s chart declares no final, in either polarity
defineLane({ phases: { phase1: { issue_1: endless } }, terminals: OK });

// ── and the three stand DOWN at the imported door ─────────────────────────
//
// The same three shapes, at a chart whose states are `string`: no marker, and
// `defineLane` compiles — because "does this chart declare an initial state" is
// not a question an imported chart can be asked, and answering it anyway would
// refuse every lane read out of a `workflow.json`.
type Imported = {
  readonly phases: { readonly phase1: { readonly issue_1: ImportedChart } };
  readonly terminals: OkTerminals;
};
export type _importedIsClean = Expect<Clean<Imported>>;

defineLane({ phases: { phase1: { issue_1: chart } }, terminals: OK });
