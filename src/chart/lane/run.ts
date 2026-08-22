// ═══════════════════════════════════════════════════════════════════════════
// THE LANE, RUN — N compiled regions behind one dispatch surface.
//
// `structure.ts` describes a lane and `report/fold.ts` folds one. Neither RUNS
// one, and running one is four separate questions:
//
//   ROUTING          `{ task, event }` must reach that task's region and no
//                    other. There is already a namespacing scheme for exactly
//                    this — `compile(chart, parts, ns)` keys the emitted table
//                    `${ns}.${event}` so N instances of one chart share a
//                    dispatch surface with disjoint literal unions. The lane's
//                    `ns` IS the task id, so the wire form of `{ task, event }`
//                    is `keyOf`'s `${task}.${event}` and this module invents
//                    nothing.
//
//   BOOT             each instance boots where ITS sub-issue actually is —
//                    `queued`, `landed`, `frozen` — so the entry state is a
//                    per-instance decision, not the chart's one static
//                    `initial: true`. `boot()` supplies it, typed to that
//                    task's own chart.
//
//   ADVANCEMENT      a phase completes when every region in it reaches a final,
//                    and the lane then advances or lands on a terminal. That
//                    rule is NOT re-implemented here: `phaseStandings` +
//                    `laneTerminalReached` are the fold's own functions, called
//                    from this module's cells. The runtime and the fold are one
//                    implementation because they are one call.
//
//   CMDS             a region's cmds leave the lane tagged with the task that
//                    emitted them, under the same `${task}.${name}` namespace
//                    the messages come back in — so an interpreter that
//                    receives `issue_5729.spawn_shell` knows where to send the
//                    reply without a side table. The tag is NESTED, under
//                    `lane`, rather than spread over the payload: a work lane's
//                    cmd may perfectly well declare a `task` of its own, and a
//                    tag that overwrote it would take the author's value with
//                    no type error to show for it.
//
//   REHYDRATION      `init(loaded)` is the branch a production restart walks,
//                    every time. A persisted state is DATA that outlived the
//                    code that wrote it — a task added since, a state renamed
//                    since — so it is validated against the lane on the way in
//                    rather than trusted and discovered mid-run, as a reducer
//                    throw inside the host's dispatch loop.
//
//   THE BUDGET       `retries` on the lane is the retry budget, `lane.context
//                    [task].maxRetries` is where `defineLane` puts it, and the
//                    fold reads it from there. A `boot()` that names a
//                    different number is refused rather than silently
//                    preferred: two numbers for one fact is how a run and a
//                    report of that run come to disagree about whether a task
//                    ever retried.
//
// WHAT THE PHASES DO NOT DO. They do not gate dispatch. A message addressed to
// a task in phase 2 moves that region while phase 1 is still active, and it is
// meant to: `foldLane` folds the WHOLE log, so a run that refused what a fold
// accepts would be the drift this module exists to rule out. Phases sequence
// the lane's own STANDING (which phase is active, when the lane advances or
// trips) — they are not admission control over the regions.
//
// WHAT IT IS NOT. This does not build a `Machine`; it builds a machine's `init`
// and `update`. `interpret` is the host's — it is required exactly when a lane
// emits cmds, and a lane knows nothing about the shells the cmds run in. The
// author writes `defineMachine({ ...runLane(lane, hands), interpret })`, and
// that call needs no cast: the two fields are already the types `defineMachine`
// demands.
// ═══════════════════════════════════════════════════════════════════════════

import type { Cmd, Reducer } from "../../pure/core";
import type { Parts } from "../compile";
import { type CompiledTable, compileTable, suppliedClause } from "../compile";
import type {
  CmdOf,
  EventName,
  MsgIn,
  MsgOf,
  StateName,
  StateOf,
} from "../graph";
import { laneTerminalReached, phaseStandings } from "../report/fold";
import { RETRY_BUDGET, statesOf } from "../report/workflow";
import {
  type Key,
  type Keyed,
  type Lane,
  type LaneRegion,
  LaneShapeError,
  type LaneTaskChart,
  type LaneTaskId,
  type LaneTerminal,
} from "./structure";

// ═══════════════════════════════════════════════════════════════════════════
// THE ALPHABETS A RUNNING LANE ADDS — the same per-task derivation `LaneState`
// and `LaneMsg` use, at the shapes a `Machine` actually consumes.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Every region's leaf state, keyed by task.
 *
 * This is `LaneState`'s information with the phase dimension left out, and the
 * omission is the point: `LaneState` is the READING shape (what is running
 * beside what, which phases are waiting), and every one of those facts is
 * derived from the leaves plus the lane's phase order. A run that stored the
 * phase standing beside the leaves would be storing a derived fact, which is
 * exactly the mistake `laneShape` exists not to make. `deriveLaneStatus(lane,
 * state.regions)` produces the compound reading whenever it is wanted.
 */
export type LaneRegions<L> = {
  readonly [T in LaneTaskId<L>]: StateOf<LaneTaskChart<L, T>>;
};

/**
 * The state of a lane in flight: every region's leaf, plus which of the three
 * things the lane itself is doing.
 *
 * `lane` is DERIVED after every step — it is `laneTerminalReached` over the
 * leaves — and it is stored because it is what a host reads to know the run is
 * over. It can never disagree with the leaves: nothing else writes it.
 */
export type LaneRunState<L> = {
  readonly regions: LaneRegions<L>;
  readonly lane: "running" | LaneTerminal<L>;
};

/**
 * The message union a running lane consumes: `{ task, event }`, on the wire.
 *
 * `MsgIn<C, NS>` is the chart module's own answer to "how does the compiled
 * table key event E under namespace NS", so instantiating it per task at
 * `NS = T` gives `${task}.${event}` with the payload that event declares — the
 * addressing pair of `LaneMsg<L>` and the key `keyOf` builds from it, which are
 * the same fact spelled for a reader and for a dispatcher.
 */
export type LaneRunMsg<L> = {
  // The `& Cmd`-shaped `{ type: string }` is a WITNESS, not a widening: at a
  // concrete lane the member's `type` is already a literal and `"x" & string`
  // IS `"x"`. It is here because `Machine`/`Reducer` constrain
  // `M extends { type: string }`, and `MsgIn`'s key is a deferred conditional
  // tsc will not reduce while `L` is a parameter — so without it the constraint
  // cannot be discharged inside this module. It sits INSIDE the mapped type, so
  // the result is still a union and `Extract<M, { type: K }>` still distributes
  // over it; hoisted outside, every cell's msg would widen back to `{ type:
  // string }` and the per-task narrowing would be gone.
  [T in LaneTaskId<L>]: MsgIn<LaneTaskChart<L, T>, T> & {
    readonly type: string;
  };
}[LaneTaskId<L>];

/** One region cmd, wearing the task that emitted it. */
type Tagged<T extends string, K> = K extends {
  readonly type: infer N extends string;
}
  ? // the same witness `LaneRunMsg` carries, for the same reason: `Cmd` is
    // `{ type: string }` and a template literal over two parameters is not
    // reduced to one while they are parameters.
    Omit<K, "type" | "lane"> & {
      readonly type: `${T}.${N}`;
      readonly lane: { readonly task: T };
    } & Cmd
  : never;

/**
 * The cmd union a running lane emits — each region's own `CmdOf<chart>`, under
 * the SAME `${task}.${name}` namespace the messages arrive in.
 *
 * The task id is carried as well as spelled into the type, because the two
 * readers differ: an interpreter's handler map is keyed by `cmd.type` (so the
 * namespace has to be in the name), while the code that routes the reply back
 * wants the task id without parsing it out of a string.
 *
 * IT IS NESTED, and `lane` is the one key a region's cmd may not use — which
 * {@link LaneRunChecks} refuses at the typed door. The tag used to be a flat
 * `task`, spread OVER the payload, and `task` is an entirely ordinary field for
 * a cmd in a work lane to carry: the author's value was replaced by the lane's
 * task id, and `Tagged` narrowed the author's field to that literal, so there
 * was no type error either. One nested key is a smaller surface than every key
 * a chart might plausibly name.
 */
export type LaneCmd<L> = {
  [T in LaneTaskId<L>]: Tagged<T, CmdOf<LaneTaskChart<L, T>>>;
}[LaneTaskId<L>];

// ═══════════════════════════════════════════════════════════════════════════
// THE HANDS — what a lane cannot derive: the code, and where each instance
// starts.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One task's half of the run.
 *
 * Both halves are typed to THAT task's chart — `parts` against its edges, its
 * guards and its cmds; `boot` against its states. Neither is a union across the
 * lane's charts, which is what makes a lane of two different templates safe to
 * hand code to.
 */
export interface LaneHand<C> {
  /** The code the chart cannot hold — assigns, guards, cmd builders, cells. */
  readonly parts: Parts<C, StateOf<C>, MsgOf<C>>;
  /**
   * Where THIS instance starts. An emitted epic boots each child where its
   * sub-issue actually is, so two instances of one chart start in two different
   * states and the chart's `initial: true` is the default rather than the law.
   *
   * Typed to THAT task's own chart, both ways: the return type is what makes
   * `() => ({ type: "queued", … })` infer the literal instead of widening to
   * `string`, and {@link LaneRunChecks} asks the same question a second time so
   * the diagnostic names the task rather than pointing at a state union.
   */
  readonly boot: () => StateOf<C>;
}

/** Every task's hand — one per region, none missing, none invented. */
export type LaneHands<L> = {
  readonly [T in LaneTaskId<L>]: LaneHand<LaneTaskChart<L, T>>;
};

/** `[string] extends [N]` — an imported chart's alphabet, which cannot be asked. */
type IsDegenerate<N> = [string] extends [N] ? true : false;

/** What `boot()` says it returns, for the task keyed `T` however it was spelled. */
type BootOf<H, T> = Keyed<H>[T & keyof Keyed<H>] extends {
  readonly boot: () => infer B;
}
  ? B
  : never;

/**
 * Tasks whose `boot()` returns a state whose `type` is no longer a LITERAL.
 *
 * Hoisting the hands to a variable is what every author does the moment a lane
 * is assembled by a helper, and without a `satisfies` it widens `boot()`'s
 * `type` from `"queued"` to `string`. The check below then cannot answer its
 * question, and used to answer a DIFFERENT one — it named a task whose boot
 * state was entirely correct and sent the author to look at the one thing that
 * was right.
 *
 * So this is asked FIRST and says what actually happened. It is the hands' half
 * of `__laneTerminalsMustBeLiteralsAddAsConst` on the spec side: the same
 * mistake, the same shape of answer.
 */
type BootLostItsLiterals<L, H> = {
  [T in LaneTaskId<L>]: [IsDegenerate<StateName<LaneTaskChart<L, T>>>] extends [
    true,
  ]
    ? never
    : [BootOf<H, T>] extends [never]
      ? never
      : [
            IsDegenerate<
              BootOf<H, T> extends { readonly type: infer S } ? S : never
            >,
          ] extends [true]
        ? T
        : never;
}[LaneTaskId<L>];

/** Tasks whose `boot()` returns something that is not a state of THEIR chart. */
type BootsOutsideItsChart<L, H> = {
  [T in LaneTaskId<L>]: [IsDegenerate<StateName<LaneTaskChart<L, T>>>] extends [
    true,
  ]
    ? never
    : [BootOf<H, T>] extends [never]
      ? never
      : // a widened boot is the finding above, not this one — one mistake, one
        // marker, and the author is not told two things about one typo.
        [
            IsDegenerate<
              BootOf<H, T> extends { readonly type: infer S } ? S : never
            >,
          ] extends [true]
        ? never
        : [BootOf<H, T>] extends [StateOf<LaneTaskChart<L, T>>]
          ? never
          : T;
}[LaneTaskId<L>];

/**
 * Tasks whose chart declares a FOREIGN event.
 *
 * `keyOf` leaves a foreign event's name bare under a namespace — on purpose:
 * `deadline_exceeded` is the same event for every instance of a chart, and the
 * name was never the author's to rename. A lane cannot hold that: a lane
 * message is addressed to ONE region, and a bare event names none of them.
 * Refused rather than broadcast, because "this event went to every region at
 * once" is a different machine than the one the phases describe.
 */
type DeclaresAForeignEvent<L> = {
  [T in LaneTaskId<L>]: [IsDegenerate<EventName<LaneTaskChart<L, T>>>] extends [
    true,
  ]
    ? never
    : [ForeignOf<LaneTaskChart<L, T>>] extends [never]
      ? never
      : T;
}[LaneTaskId<L>];

type ForeignOf<C> = C extends { readonly events: infer E }
  ? {
      [K in keyof E]: E[K] extends { readonly foreign: true } ? K : never;
    }[keyof E]
  : never;

/**
 * Tasks whose chart declares a cmd carrying `lane` — the one reserved key.
 *
 * {@link LaneCmd} nests the task id under `lane` and a nested tag can still be
 * shadowed by a payload that spells the same key. It is refused rather than
 * silently overwritten, because "the field you declared is not the field your
 * interpreter receives" is the exact defect nesting was introduced to end.
 */
type CmdCarriesTheLaneTag<L> = {
  [T in LaneTaskId<L>]: [
    Extract<CmdOf<LaneTaskChart<L, T>>, { readonly lane: unknown }>,
  ] extends [never]
    ? never
    : T;
}[LaneTaskId<L>];

/** The five authoring mistakes a RUN can make that a drawing cannot. */
export type LaneRunChecks<L, H> = ([
  Exclude<Key<keyof H>, LaneTaskId<L>>,
] extends [never]
  ? unknown
  : {
      readonly __laneHandNamesAnUnknownTask: Exclude<
        Key<keyof H>,
        LaneTaskId<L>
      >;
    }) &
  ([BootLostItsLiterals<L, H>] extends [never]
    ? unknown
    : {
        readonly __laneHandsLostTheirLiteralTypesAddSatisfiesLaneHands: BootLostItsLiterals<
          L,
          H
        >;
      }) &
  ([BootsOutsideItsChart<L, H>] extends [never]
    ? unknown
    : {
        readonly __laneTaskBootsIntoAStateItsChartDoesNotDeclare: BootsOutsideItsChart<
          L,
          H
        >;
      }) &
  ([DeclaresAForeignEvent<L>] extends [never]
    ? unknown
    : {
        readonly __laneRegionChartDeclaresAForeignEvent: DeclaresAForeignEvent<L>;
      }) &
  ([CmdCarriesTheLaneTag<L>] extends [never]
    ? unknown
    : {
        readonly __laneRegionCmdDeclaresTheReservedLaneField: CmdCarriesTheLaneTag<L>;
      });

/**
 * The self-referential constraint `runLane` binds its hands with.
 *
 * The CHECKS come first in the intersection, and the order is load-bearing for
 * the diagnostic rather than for the semantics: tsc reports the first
 * constituent that fails, so a hands object that boots a task into the wrong
 * state is told which RULE it broke and which TASK broke it, instead of being
 * handed that task's whole state union to compare by eye.
 */
export type LaneHandsOf<L, H> = LaneRunChecks<L, H> & LaneHands<L>;

/**
 * A lane's `init` and `update` — the two halves of a `Machine` a lane can
 * derive, and exactly the two.
 */
export interface LaneRuntime<L> {
  readonly init: (
    loaded: LaneRunState<L> | null,
  ) => readonly [LaneRunState<L>, readonly LaneCmd<L>[]];
  readonly update: Reducer<LaneRunState<L>, LaneRunMsg<L>, LaneCmd<L>>;
}

// ── the erased shapes the dispatch actually walks ──────────────────────────

/** A region leaf, as the router reads it: a name, and whatever else it carries. */
type RtLeaf = {
  readonly type: string;
  /** Present on a parked leaf: the state a `resume` will land back on. */
  readonly was?: string;
  /** Present where the chart's ctx carries a budget — the guard's right side. */
  readonly maxRetries?: number;
};
type RtRunState = {
  readonly regions: Readonly<Record<string, RtLeaf>>;
  readonly lane: string;
};
type RtMsg = { readonly type: string };
/** The hand, after the type layer has done its work — cf. `rtParts`. */
type RtHand = {
  readonly parts: object;
  readonly boot: () => { readonly type: string };
};

/** What `runLane` reads off the spec: the charts, still carrying their types. */
type RunnableSpec = {
  readonly phases: Readonly<
    Record<string, Readonly<Record<string, LaneRegion>>>
  >;
};

const isForeign = (event: unknown): boolean =>
  typeof event === "object" &&
  event !== null &&
  "foreign" in event &&
  event.foreign === true;

/**
 * Why a dot is refused in a task id and in an event name.
 *
 * A dispatch key is `task` + `.` + `event`, and every reader splits it at the
 * FIRST dot — `bareEvent`, `liveFeed`'s `address`, the replayer over `events.jsonl`.
 * So task `a` with event `b.GO` and task `a.b` with event `GO` register the
 * same key `a.b.GO`, one of them wins the table and the other's event is
 * unreachable for the life of the process; and a task id with a dot in it
 * writes a log the replayer re-partitions into a task that does not exist.
 * `Total<C>` already bans the dot in a state name and in a foreign event name
 * for exactly this reason — this is that rule at the runtime door, where the
 * imported chart's alphabet is `string` and no type can carry it.
 */
const DOT =
  "a dispatch key is the task id, a dot, then the event name — and every reader splits it at the FIRST dot, so a dot here makes two different messages one key";

/** The bare event a dispatch key carries — with the dot refused, split once. */
const bare = (taskId: string, key: string): string =>
  key.startsWith(`${taskId}.`) ? key.slice(taskId.length + 1) : key;

/**
 * A leaf with the `was` it arrived with, and no `was` at all where there was
 * none — the fold's `{ ...state, type }`, which never adds the field.
 */
const carryWas = (leaf: RtLeaf, was: string | undefined): RtLeaf => {
  if (was !== undefined) return { ...leaf, was };
  const { was: _dropped, ...rest } = leaf;
  return rest;
};

/**
 * Run a lane: one compiled region per task, one dispatch surface, one derived
 * lane standing.
 *
 * ```ts
 * const epic = defineLane({
 *   phases: { phase1: { issue_5729: coder, issue_5730: coder } },
 *   terminals: { complete: "complete", tripped: "tripped" },
 * });
 *
 * const machine = defineMachine({
 *   ...runLane(epic, {
 *     issue_5729: { parts, boot: () => ({ type: "queued", retries: 0, maxRetries: 2 }) },
 *     // this one is already merged on GitHub — it boots where it IS.
 *     issue_5730: { parts, boot: () => ({ type: "shipped", retries: 0, maxRetries: 2 }) },
 *   }),
 *   interpret,
 * });
 * ```
 *
 * @throws {LaneShapeError} for the run-time half of what the markers say: a
 *   task with no chart on the spec, a region declaring a foreign event, and a
 *   `boot()` landing on a state its chart does not declare.
 */
// ── the accepted-set audit, imported/runtime door (#23) ─────────────────────
//
// The companion to `structure.ts`'s audit above `LaneShapeError`: these are the
// lane-shape refusals raised at wiring, load and boot, read against the same
// compiler principle (name the set that WOULD have been accepted). Verdicts:
//
//   set named (through `suppliedClause`):
//     • no hand was given for a task — the tasks a hand WAS supplied for.
//     • a persisted leaf names a task this lane does not run — the tasks the
//       lane runs.
//     • a leaf / its `was` stands in a state the chart does not declare — the
//       states the chart declares (the lane twin of `NoCellError`, #20).
//
//   no set — recorded beside the throw, with the reason:
//     • spec holds no chart / `charts` hold none — an internal invariant, an
//       absence with nothing to enumerate.
//     • a task id or event name carries a dot — a shape refusal; the rule is
//       the message.
//     • a chart declares an event foreign — a shape refusal; the reason is the
//       message.
//     • a run holds no leaf for a task — an absence, not a wrong pick.
//     • `maxRetries` contradicts the budget — a scalar mismatch; both numbers
//       are already named, and the source of truth is one value, not a set.
//     • no cell for a msg at dispatch — NOT a shape refusal: it fires on a
//       well-formed lane at step time, so its accepted set belongs to the
//       `NoCellError` / `acceptedTypes` family (#20/#21), not this helper.
export function runLane<
  L extends Lane<RunnableSpec>,
  const H extends LaneHandsOf<L, H>,
>(lane: L, hands: H): LaneRuntime<L> {
  // A mapped type over the task ids IS a record keyed by them; widening to the
  // erased view is an assignment, not a cast, and it is what lets the walk
  // below index by a task id it read off the lane.
  const byTask: Readonly<Record<string, RtHand>> = hands;

  const defects: string[] = [];
  const tables = new Map<string, CompiledTable>();
  const boots = new Map<string, () => RtLeaf>();
  /** `${state}.${event}` per task, for the edges that RESUME — see `update`. */
  const resumes = new Map<string, ReadonlySet<string>>();

  for (const phase of lane.phases) {
    for (const taskId of phase.tasks) {
      const region = lane.spec.phases[phase.name]?.[taskId];
      const hand = byTask[taskId];
      // `lane.charts` is what every OTHER reader walks — the fold, the
      // inspector, the boot check below, the event list `update` is keyed from.
      // A task the phases declare and the charts do not is the one input where
      // this module's closing cast asserts something false, so it is a defect
      // here rather than a `continue` that quietly drops the region.
      const chart = lane.charts[taskId];
      if (region === undefined || hand === undefined || chart === undefined) {
        // The spec/charts arms are internal-invariant absences (#23): a lane
        // whose own spec or `charts` disagree with its phases, with nothing to
        // enumerate. The no-hand arm is the caller's mistake, and it names the
        // tasks a hand WAS supplied for so a misplaced key is legible.
        defects.push(
          `task "${taskId}": the lane declares it but ${
            region === undefined
              ? "its spec holds no chart"
              : chart === undefined
                ? "the lane's `charts` hold none for it"
                : "no hand was given for it" +
                  suppliedClause("hands", Object.keys(byTask))
          }`,
        );
        continue;
      }
      // NO SET (#23): a shape refusal — the rule ("no dot") is the message.
      if (taskId.includes(".")) {
        defects.push(
          `task "${taskId}": a task id may not carry a dot — ${DOT}`,
        );
      }
      for (const [name, event] of Object.entries(region.events)) {
        // NO SET (#23): a shape refusal — the reason a foreign event cannot be
        // routed is the whole message; there is no admitted enumeration.
        if (isForeign(event)) {
          defects.push(
            `task "${taskId}": its chart declares "${name}" foreign — a foreign event keeps its BARE name under a namespace, so a lane message carrying it addresses no region in particular`,
          );
        }
        // NO SET (#23): a shape refusal, the event-name twin of the task-id dot.
        if (name.includes(".")) {
          defects.push(
            `task "${taskId}": its chart declares the event "${name}" — an event name may not carry a dot, ${DOT}`,
          );
        }
      }
      // ONE region → ONE compiled table, namespaced by the task id. This is
      // `compile(chart, parts, ns)` with `ns = taskId`, and the reason the
      // routing needed no second scheme.
      tables.set(taskId, compileTable(region, hand.parts, taskId));
      boots.set(taskId, hand.boot);
      const sites = new Set<string>();
      for (const [name, node] of statesOf(chart)) {
        for (const [event, edge] of Object.entries(node.on ?? {})) {
          if ("resume" in edge) sites.add(`${name}.${event}`);
        }
      }
      resumes.set(taskId, sites);
    }
  }
  if (defects.length > 0) throw new LaneShapeError(defects);

  /** The lane's own standing, after the leaves moved. The fold's two functions. */
  const standingOf = (regions: Readonly<Record<string, RtLeaf>>): string =>
    laneTerminalReached(phaseStandings(lane, regions), lane.terminals) ??
    "running";

  /** The budget the LANE declares for a task — `defineLane`'s `retries`. */
  const budgetOf = (taskId: string): number =>
    lane.context[taskId]?.maxRetries ?? RETRY_BUDGET;

  /**
   * Every region's leaf against the lane, with EVERY defect named.
   *
   * One site for both doors, because they are the same question asked of two
   * origins: `boot()` produces a leaf from code, a restart produces one from
   * storage, and neither is checked by any type at the imported door. What is
   * asked is what the rest of the module then assumes — the task set is
   * exactly the lane's, every `type` is a state of that task's chart, every
   * `was` is too (it is a TARGET: a resume walks to it, so a `was` the chart
   * does not declare is a region that lands nowhere), and the retry budget is
   * the lane's own.
   */
  const check = (
    regions: Readonly<Record<string, unknown>>,
    origin: string,
  ): readonly string[] => {
    const bad: string[] = [];
    for (const taskId of Object.keys(regions)) {
      // SET NAMED (#23): the tasks this lane runs, so a leaf left by an older
      // build reads against the current task set instead of in isolation.
      if (!boots.has(taskId)) {
        bad.push(
          `${origin}: it names task "${taskId}", which this lane does not run — a state written by an older build of the lane is not a state this one can load` +
            suppliedClause("tasks", [...boots.keys()]),
        );
      }
    }
    for (const taskId of boots.keys()) {
      const chart = lane.charts[taskId];
      if (chart === undefined) continue;
      const raw = regions[taskId];
      const leaf =
        typeof raw === "object" && raw !== null ? (raw as RtLeaf) : undefined;
      // NO SET (#23): an absence — the leaf is missing, not standing in a wrong
      // place, so there is no state or task set the sentence could point at.
      if (leaf === undefined || typeof leaf.type !== "string") {
        bad.push(
          `${origin}: it holds no leaf for task "${taskId}" — every region of the lane has to be standing somewhere`,
        );
        continue;
      }
      const states = statesOf(chart);
      const declared = [...states.keys()];
      // the runtime half of `__laneTaskBootsIntoAStateItsChartDoesNotDeclare`,
      // and the only net at the imported door, where the marker stands down.
      //
      // SET NAMED (#23): the states the chart declares — the lane twin of
      // `NoCellError` naming its accepted set (#20). A leaf in an unknown state
      // learns which states are the real ones from the refusal itself.
      if (!states.has(leaf.type)) {
        bad.push(
          `${origin}: task "${taskId}" stands in "${leaf.type}", which its chart does not declare` +
            suppliedClause("states", declared),
        );
      }
      // SET NAMED (#23): the same declared-state set — `was` is a resume TARGET,
      // so naming the real states says where a resume could legitimately land.
      if (leaf.was !== undefined && !states.has(leaf.was)) {
        bad.push(
          `${origin}: task "${taskId}" carries \`was: "${leaf.was}"\`, which its chart does not declare — a resume would walk it to a state that does not exist` +
            suppliedClause("states", declared),
        );
      }
      // NO SET (#23): a scalar mismatch. Both numbers are already named and the
      // source of truth is one value (the lane's `retries`), not a set to pick
      // from — the fix is to drop the persisted copy, which the message says.
      const budget = budgetOf(taskId);
      if (typeof leaf.maxRetries === "number" && leaf.maxRetries !== budget) {
        bad.push(
          `task "${taskId}": its \`maxRetries\` is ${leaf.maxRetries} and the lane's budget for it is ${budget} — the lane's \`retries\` is the one source of that number (\`lane.context\`, which \`foldLane\` reads), so a run carrying a second one reports a different task than the one it ran`,
        );
      }
    }
    return bad;
  };

  const init = (loaded: RtRunState | null): readonly [RtRunState, never[]] => {
    // Invariant 2: a rehydrated lane keeps its leaves verbatim, and emits no
    // cmds. VERBATIM, not unread — this is the branch every production restart
    // walks, and what it is handed is data that outlived the code that wrote
    // it. The standing is the one field NOT taken back: it is derived from the
    // leaves by `standingOf` and nothing else may write it, so re-deriving it
    // costs one walk and makes a persisted standing that disagrees with its own
    // leaves impossible to load.
    if (loaded !== null) {
      const bad = check(
        loaded.regions ?? {},
        "this lane cannot resume the state it was handed",
      );
      if (bad.length > 0) throw new LaneShapeError(bad);
      return [
        { regions: loaded.regions, lane: standingOf(loaded.regions) },
        [],
      ];
    }
    const regions: Record<string, RtLeaf> = {};
    for (const [taskId, boot] of boots) regions[taskId] = boot();
    const bad = check(regions, "this lane cannot boot");
    if (bad.length > 0) throw new LaneShapeError(bad);
    // A lane can boot ALREADY finished — every child landed before the run
    // started — so the standing is derived at boot by the same rule that
    // derives it after every step, rather than assumed to be "running".
    return [{ regions, lane: standingOf(regions) }, []];
  };

  const update: Record<
    string,
    (s: RtRunState, m: RtMsg) => readonly [RtRunState, readonly Cmd[]]
  > = {};

  for (const [taskId, table] of tables) {
    // total by construction: a task with no chart was refused above, so the
    // key set this loop builds is exactly the tasks × their charts' events —
    // which is what the closing cast asserts.
    const chart = lane.charts[taskId];
    const resumeSites = resumes.get(taskId) ?? new Set<string>();
    if (chart === undefined) continue;
    for (const event of Object.keys(chart.events)) {
      // `keyOf(chart, event, taskId)` — with the foreign case refused above,
      // every key is the decorated one.
      update[`${taskId}.${event}`] = (state, msg) => {
        const leaf = state.regions[taskId];
        const cell =
          leaf === undefined ? undefined : table[leaf.type]?.[msg.type];
        // NOT a shape refusal (#23): this fires at DISPATCH time on a
        // well-formed lane, so it is the lane twin of `NoCellError`, not of the
        // structure defects above. Its accepted set (the msg types this state's
        // compiled table holds) is the `acceptedTypes` family's question
        // (#20/#21), read at the machine's own selection site — not this
        // helper's, which speaks the compiler's "supplied" register. Left to
        // that family rather than answered here in a foreign voice.
        if (leaf === undefined || cell === undefined) {
          throw new LaneShapeError([
            `task "${taskId}": no cell for "${msg.type}" in state "${leaf?.type ?? "<none>"}"`,
          ]);
        }
        const [moved, cmds] = cell(leaf, msg);
        // ── `was`, ON A RESUME ──────────────────────────────────────────────
        // The fold's rule, applied to the compiled cell's output: `stepTask`
        // returns `{ ...state, type: was ?? fallback }` on a resume and does
        // NOT rewrite `was` — you are LEAVING the park, not entering one —
        // while `buildCell` re-injects `was = st.type` for any landing in a
        // parking state, resume included.
        //
        // With ONE parking state the two never differ where it is read: a
        // resume out of it lands somewhere unparked, so the injection writes a
        // field nothing reads again. With TWO mutually reachable parking states
        // a resume lands ON a parking state, the injection overwrites the `was`
        // the fold kept, and the NEXT resume walks the run and the report to
        // two different STATES. That is not a `was` divergence any more.
        const next = resumeSites.has(`${leaf.type}.${bare(taskId, msg.type)}`)
          ? carryWas(moved, leaf.was)
          : moved;
        const regions = { ...state.regions, [taskId]: next };
        return [
          { regions, lane: standingOf(regions) },
          // the cmds leave wearing their task, under the namespace the replies
          // will come back in — BESIDE the payload, never over it.
          cmds.map((cmd) => ({
            ...cmd,
            lane: { task: taskId },
            type: `${taskId}.${cmd.type}`,
          })),
        ];
      };
    }
  }

  // ── THE ONE CAST ────────────────────────────────────────────────────────
  // `compile`'s cast, one layer up and for the same reason. `Reducer` is a
  // mapped type over `M["type"]`; this walk builds exactly those keys from the
  // tasks × their charts' events, and tsc cannot see that a string-keyed record
  // built in a loop is total over the union. `LaneRunState`'s `regions` is the
  // same story one level in: a record built by iterating the lane's tasks IS
  // the mapped type over them.
  return { init, update } as unknown as LaneRuntime<L>;
}
