// PROBE 1: a typo'd target state.
import { defineChart } from "../graph";
export const g = defineChart({
  events: {
    WIP: { scope: "edges" },
    BLOCKED: { scope: "edges" },
    DONE: { scope: "edges" },
    PASS: { scope: "edges" },
  },
  states: {
    only: {
      queued: { on: { WIP: "build", BLOCKED: "blocked" } },
      build: { on: { DONE: "reveiw" } }, //        ← typo: "reveiw" is not a state
      review: { on: { PASS: "ship" } },
      ship: {},
      blocked: {},
    },
  },
});
