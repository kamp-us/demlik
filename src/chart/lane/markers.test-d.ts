// ═══════════════════════════════════════════════════════════════════════════
// THE FOUR AUTHORING MISTAKES THE TYPE LAYER CAN SEE.
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
// WHAT IS NOT HERE, and it is deliberate: every rule about a chart's INSIDES —
// no initial state, no final — is a runtime check in `defineLane`, because an
// `ImportedChart` is runtime-typed by construction and the type layer cannot be
// asked. `lane.test.ts` pins those.
// ═══════════════════════════════════════════════════════════════════════════
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
