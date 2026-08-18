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
//                    reply without a side table.
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
import { type CompiledTable, compileTable } from "../compile";
import type {
  CmdOf,
  EventName,
  MsgIn,
  MsgOf,
  StateName,
  StateOf,
} from "../graph";
import { laneTerminalReached, phaseStandings } from "../report/fold";
import { statesOf } from "../report/workflow";
import {
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
    Omit<K, "type"> & { readonly type: `${T}.${N}`; readonly task: T } & Cmd
  : never;

/**
 * The cmd union a running lane emits — each region's own `CmdOf<chart>`, under
 * the SAME `${task}.${name}` namespace the messages arrive in.
 *
 * The `task` field is carried as well as spelled into the type, because the two
 * readers differ: an interpreter's handler map is keyed by `cmd.type` (so the
 * namespace has to be in the name), while the code that routes the reply back
 * wants the task id without parsing it out of a string.
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

/** Tasks whose `boot()` returns something that is not a state of THEIR chart. */
type BootsOutsideItsChart<L, H> = {
  [T in LaneTaskId<L>]: [IsDegenerate<StateName<LaneTaskChart<L, T>>>] extends [
    true,
  ]
    ? never
    : T extends keyof H
      ? H[T] extends { readonly boot: () => infer B }
        ? [B] extends [StateOf<LaneTaskChart<L, T>>]
          ? never
          : T
        : never
      : never;
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

/** The three authoring mistakes a RUN can make that a drawing cannot. */
export type LaneRunChecks<L, H> = ([Exclude<keyof H, LaneTaskId<L>>] extends [
  never,
]
  ? unknown
  : {
      readonly __laneHandNamesAnUnknownTask: Exclude<keyof H, LaneTaskId<L>>;
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
type RtLeaf = { readonly type: string };
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

  for (const phase of lane.phases) {
    for (const taskId of phase.tasks) {
      const region = lane.spec.phases[phase.name]?.[taskId];
      const hand = byTask[taskId];
      if (region === undefined || hand === undefined) {
        defects.push(
          `task "${taskId}": the lane declares it but ${
            region === undefined
              ? "its spec holds no chart"
              : "no hand was given for it"
          }`,
        );
        continue;
      }
      for (const [name, event] of Object.entries(region.events)) {
        if (isForeign(event)) {
          defects.push(
            `task "${taskId}": its chart declares "${name}" foreign — a foreign event keeps its BARE name under a namespace, so a lane message carrying it addresses no region in particular`,
          );
        }
      }
      // ONE region → ONE compiled table, namespaced by the task id. This is
      // `compile(chart, parts, ns)` with `ns = taskId`, and the reason the
      // routing needed no second scheme.
      tables.set(taskId, compileTable(region, hand.parts, taskId));
      boots.set(taskId, hand.boot);
    }
  }
  if (defects.length > 0) throw new LaneShapeError(defects);

  /** The lane's own standing, after the leaves moved. The fold's two functions. */
  const standingOf = (regions: Readonly<Record<string, RtLeaf>>): string =>
    laneTerminalReached(phaseStandings(lane, regions), lane.terminals) ??
    "running";

  const init = (loaded: RtRunState | null): readonly [RtRunState, never[]] => {
    // Invariant 2: a rehydrated lane is returned verbatim, with no cmds.
    if (loaded !== null) return [loaded, []];
    const regions: Record<string, RtLeaf> = {};
    const bad: string[] = [];
    for (const [taskId, boot] of boots) {
      const leaf = boot();
      // the runtime half of `__laneTaskBootsIntoAStateItsChartDoesNotDeclare`,
      // and the only net at the imported door, where the marker stands down.
      const chart = lane.charts[taskId];
      if (chart !== undefined && !statesOf(chart).has(leaf.type)) {
        bad.push(
          `task "${taskId}": boots into "${leaf.type}", which its chart does not declare`,
        );
      }
      regions[taskId] = leaf;
    }
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
    const chart = lane.charts[taskId];
    if (chart === undefined) continue;
    for (const event of Object.keys(chart.events)) {
      // `keyOf(chart, event, taskId)` — with the foreign case refused above,
      // every key is the decorated one.
      update[`${taskId}.${event}`] = (state, msg) => {
        const leaf = state.regions[taskId];
        const cell =
          leaf === undefined ? undefined : table[leaf.type]?.[msg.type];
        if (leaf === undefined || cell === undefined) {
          throw new LaneShapeError([
            `task "${taskId}": no cell for "${msg.type}" in state "${leaf?.type ?? "<none>"}"`,
          ]);
        }
        const [next, cmds] = cell(leaf, msg);
        const regions = { ...state.regions, [taskId]: next };
        return [
          { regions, lane: standingOf(regions) },
          // the cmds leave wearing their task, under the namespace the replies
          // will come back in.
          cmds.map((cmd) => ({
            ...cmd,
            task: taskId,
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
