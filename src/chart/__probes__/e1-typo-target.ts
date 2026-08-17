// PROBE 1: a typo'd target state.
import { defineGraph } from "../graph";
export const g = defineGraph({
  queued: { on: { WIP: "build", BLOCKED: "blocked" } },
  build: { on: { DONE: "reveiw" } }, //            ← typo: "reveiw" is not a state
  review: { on: { PASS: "ship" } },
  ship: {},
  blocked: {},
});
