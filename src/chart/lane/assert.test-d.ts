// ═══════════════════════════════════════════════════════════════════════════
// IDENTITY ASSERTIONS OVER A TYPED LANE — one formula, read at both doors.
//
// A type-only file, exactly like `src/chart/assert.test-d.ts`: `tsconfig.json`
// excludes `*.test.ts` from the shipped build and `tsconfig.test.json` puts it
// back, so `pnpm typecheck:test` IS the assertion. `Eq<A,B>` is the
// invariant-position trick, so an `any` or a `never` that crept into a
// derivation does NOT slip past.
//
// The lane under test is the real thing: two phases, three tasks, and — in the
// second half — TWO DIFFERENT CHART TEMPLATES in one phase, which is the case
// that separates "narrowed per task" from "a union across the lane's charts".
// ═══════════════════════════════════════════════════════════════════════════
import { lane as coder, type LaneG } from "../__fixtures__/lane";
import {
  type Assert,
  defineChart,
  type Eq,
  type EventName,
  type StateOf,
  ty,
} from "../graph";
import type { ImportedChart, ImportedLane } from "../report/workflow";
import {
  defineLane,
  type LaneErrorFinals,
  type LaneInitial,
  type LaneMsg,
  type LanePhaseName,
  type LanePhaseOf,
  type LaneSiblings,
  type LaneState,
  type LaneSuccessFinals,
  type LaneTaskChart,
  type LaneTaskId,
  type LaneTasksIn,
  type LaneTerminal,
  type PhaseAtRest,
} from "./structure";

// ── the worked example ─────────────────────────────────────────────────────
const epic = defineLane({
  id: "epic-5728",
  phases: {
    phase1: { issue_5729: coder, issue_5730: coder },
    phase2: { issue_5731: coder },
  },
  terminals: { complete: "complete", tripped: "tripped" },
  retries: { issue_5731: 5 },
});
type L = typeof epic;

// ── the topology, kept ─────────────────────────────────────────────────────
export type _phases = Assert<Eq<LanePhaseName<L>, "phase1" | "phase2">>;
export type _tasks = Assert<
  Eq<LaneTaskId<L>, "issue_5729" | "issue_5730" | "issue_5731">
>;
export type _tasksIn = Assert<
  Eq<LaneTasksIn<L, "phase1">, "issue_5729" | "issue_5730">
>;
export type _phaseOf = Assert<Eq<LanePhaseOf<L, "issue_5731">, "phase2">>;
/** The tasks running BESIDE this one — its phase's set, minus itself. */
export type _siblings = Assert<Eq<LaneSiblings<L, "issue_5729">, "issue_5730">>;
export type _alone = Assert<Eq<LaneSiblings<L, "issue_5731">, never>>;
export type _terminals = Assert<Eq<LaneTerminal<L>, "complete" | "tripped">>;

// ── each task's chart, and what is read OFF it ─────────────────────────────
export type _chart = Assert<Eq<LaneTaskChart<L, "issue_5730">, LaneG>>;
export type _initial = Assert<Eq<LaneInitial<L, "issue_5730">, "queued">>;
/** Final POLARITY, still split, still off the chart itself. */
export type _ok = Assert<Eq<LaneSuccessFinals<L, "issue_5731">, "shipped">>;
export type _err = Assert<Eq<LaneErrorFinals<L, "issue_5731">, "frozen">>;

// ── the compound state ─────────────────────────────────────────────────────
//
// Per phase, per task, THAT task's own `StateOf<chart>` — not a union across
// the lane. A phase that is not carrying task states carries a standing.
export type _stateKeys = Assert<
  Eq<keyof LaneState<L>["phases"], "phase1" | "phase2">
>;
export type _phase1 = Assert<
  Eq<
    LaneState<L>["phases"]["phase1"],
    | PhaseAtRest
    | {
        readonly issue_5729: StateOf<LaneG>;
        readonly issue_5730: StateOf<LaneG>;
      }
  >
>;
export type _phase2 = Assert<
  Eq<
    LaneState<L>["phases"]["phase2"],
    PhaseAtRest | { readonly issue_5731: StateOf<LaneG> }
  >
>;
/** The lane's own standing: running, or the terminal it ended on. */
export type _laneStanding = Assert<
  Eq<LaneState<L>["lane"], "running" | "complete" | "tripped">
>;

// ── the message ────────────────────────────────────────────────────────────
export type _msg = Assert<
  Eq<
    LaneMsg<L>,
    | { readonly task: "issue_5729"; readonly event: EventName<LaneG> }
    | { readonly task: "issue_5730"; readonly event: EventName<LaneG> }
    | { readonly task: "issue_5731"; readonly event: EventName<LaneG> }
  >
>;

// ── TWO TEMPLATES IN ONE PHASE — where the narrowing earns its keep ────────
//
// `packer` and `coder` share not one event name. A lane holding both must not
// let the packer's alphabet reach the coder's task, and a `LaneMsg` built as
// one alphabet across the lane's charts would do exactly that.
//
// It is `upload` MINUS ITS GUARD, and the subtraction is the point rather than
// an inconvenience: `upload` guards on `tries < 3` off its own state data, and
// the lane's fold walks every guarded edge with `retries < maxRetries` off the
// lane's context — a predicate the chart never declared. So `upload` is a chart
// a lane can RUN and cannot FOLD, and `__laneRegionGuardsOnSomethingOtherThan
// TheRetryBudget` refuses it at the door instead of letting a report describe a
// run that did something else. `e61` is that refusal, pinned.
const packer = defineChart({
  events: {
    pick: { data: ty<{ readonly key: string }>(), scope: "edges" },
    done: { data: ty<{ readonly etag: string }>(), scope: "edges" },
    ok: { scope: "edges" },
  },
  states: {
    live: {
      idle: { initial: true, on: { pick: "sending" } },
      sending: { on: { done: "checking" } },
      checking: { on: { ok: "stored" } },
    },
    finished: { stored: { end: true } },
  },
});

const mixed = defineLane({
  phases: { phase1: { work: coder, file: packer } },
  terminals: { complete: "complete", tripped: "tripped" },
});
type M = typeof mixed;

export type _mixedCharts = Assert<Eq<LaneTaskChart<M, "file">, typeof packer>>;
export type _mixedMsg = Assert<
  Eq<
    LaneMsg<M>,
    | { readonly task: "work"; readonly event: EventName<LaneG> }
    | { readonly task: "file"; readonly event: EventName<typeof packer> }
  >
>;
/** The packer's events, narrowed to the packer's task. */
export type _mixedEvent = Assert<
  Eq<
    Extract<LaneMsg<M>, { readonly task: "file" }>["event"],
    EventName<typeof packer>
  >
>;
export type _mixedState = Assert<
  Eq<
    Exclude<LaneState<M>["phases"]["phase1"], PhaseAtRest>,
    { readonly work: StateOf<LaneG>; readonly file: StateOf<typeof packer> }
  >
>;

// ── THE OTHER DOOR — the same derivations, at `Chart<unknown>` ─────────────
//
// An imported lane carries no spec, so every derivation above runs over the
// imported shape instead and degenerates to the `string` the imported door has
// always been. This is the assertion that keeps "two doors, one representation"
// honest: nothing here is a second code path, it is the same formula at a
// weaker instantiation.
export type _importedMsg = Assert<
  Eq<LaneMsg<ImportedLane>, { readonly task: string; readonly event: string }>
>;
export type _importedTasks = Assert<Eq<LaneTaskId<ImportedLane>, string>>;
export type _importedTerminals = Assert<Eq<LaneTerminal<ImportedLane>, string>>;
export type _importedFinals = Assert<
  Eq<LaneSuccessFinals<ImportedLane, string>, string>
>;
export type _importedLaneStanding = Assert<
  Eq<LaneState<ImportedLane>["lane"], string>
>;

// ── and the value is STILL the one representation ──────────────────────────
//
// The typed door buys types, not a second lane: what `defineLane` returns is an
// `ImportedLane` with a `spec` beside it, so the fold, the report and the
// inspector take it untouched.
export type _oneRepresentation = Assert<
  Eq<L["charts"], Readonly<Record<string, ImportedChart>>>
>;
export type _stillImported = Assert<L extends ImportedLane ? true : false>;
