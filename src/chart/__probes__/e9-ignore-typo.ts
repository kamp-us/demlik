// PROBE 9: a refusal is only a refusal if it names a REAL event. A typo'd
// `ignore` entry would otherwise refuse nothing and leave the true pair open.
import { defineGraph } from "../graph";
export const g = defineGraph({
  queued: { on: { WIP: "build" }, ignore: ["DONE"] },
  build: { on: { DONE: "queued" }, ignore: ["WPI"] }, // ← typo: "WPI"
});
