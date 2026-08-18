// ═══════════════════════════════════════════════════════════════════════════
// THE ALPHABET, WHERE THE TASK ID IS A NUMBER.
//
// `assert.test-d.ts` pins the lane's derivations over ids that are words. This
// pins the case that used to annihilate them: fabrika's task ids are GitHub
// issue numbers, so `{ 5729: coder }` is the obvious spelling of a phase, and
// `Extract<keyof …, string>` erased every numeric key it met. `LaneTaskId`,
// `LaneMsg` and `LaneHands` all read back `never` — zero hands demanded, and
// the CORRECT hand rejected with `'5729' does not exist in type LaneHandsOf<…>`.
//
// A key is a key. It is normalised to the way every OTHER layer already spells
// one — the log's `task` field, the `${task}.${event}` wire key,
// `Object.entries` — which is as a string.
//
// A type-only file, like `assert.test-d.ts`: `pnpm typecheck:test` IS the
// assertion, and `Eq<A,B>` is the invariant-position trick, so a `never` that
// crept back into a derivation does not slip past.
// ═══════════════════════════════════════════════════════════════════════════
import { type Assert, defineChart, type Eq } from "../graph";
import {
  defineLane,
  type LaneMsg,
  type LanePhaseName,
  type LanePhaseOf,
  type LaneSiblings,
  type LaneTaskChart,
  type LaneTaskId,
  type LaneTasksIn,
} from "./structure";

const build = defineChart({
  events: { GO: { scope: "edges" } },
  states: {
    only: {
      queued: { initial: true, on: { GO: "shipped" } },
      shipped: { end: true },
    },
  },
});

const numbered = defineLane({
  phases: { 1: { 5729: build, 5730: build }, 2: { 5731: build } },
  terminals: { complete: "complete", tripped: "tripped" },
  retries: { 5729: 5 },
});
type N = typeof numbered;

export type _phases = Assert<Eq<LanePhaseName<N>, "1" | "2">>;
export type _tasks = Assert<Eq<LaneTaskId<N>, "5729" | "5730" | "5731">>;
export type _tasksIn = Assert<Eq<LaneTasksIn<N, "1">, "5729" | "5730">>;
export type _phaseOf = Assert<Eq<LanePhaseOf<N, "5731">, "2">>;
export type _siblings = Assert<Eq<LaneSiblings<N, "5729">, "5730">>;

/** The chart is still THAT task's chart, reached through the string key. */
export type _chart = Assert<Eq<LaneTaskChart<N, "5729">, typeof build>>;

export type _msg = Assert<
  Eq<
    LaneMsg<N>,
    | { readonly task: "5729"; readonly event: "GO" }
    | { readonly task: "5730"; readonly event: "GO" }
    | { readonly task: "5731"; readonly event: "GO" }
  >
>;
