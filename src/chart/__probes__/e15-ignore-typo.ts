// PROBE 15: a refusal is only a refusal if it names a REAL event. A typo'd
// `ignore` entry would otherwise refuse nothing and leave the true pair open.
// @expect-error: TS2322
import { defineChart } from "../graph";
export const g = defineChart({
  events: { WIP: { scope: "phase" }, DONE: { scope: "phase" } },
  states: {
    phase: {
      queued: { on: { WIP: "build" }, ignore: ["DONE"] },
      build: { on: { DONE: "queued" }, ignore: ["WPI"] }, // ← typo: "WPI"
    },
  },
});
