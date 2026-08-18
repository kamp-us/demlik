// PROBE 16 (new): a state name declared under two phases. Phase membership is
// structural — a state IS in the phase whose key it sits under — so declaring
// it twice makes "which phase is `blocked` in?" ambiguous, and every scope
// decision that reads the phase would silently apply twice.
// @expect-error: TS2322 TS2322
import { defineChart } from "../graph";
export const g = defineChart({
  events: { UNBLOCKED: { scope: "edges" } },
  states: {
    working: { blocked: { on: { UNBLOCKED: "blocked" } } },
    parked: { blocked: { on: { UNBLOCKED: "blocked" } } }, // ← same name, two phases
  },
});
