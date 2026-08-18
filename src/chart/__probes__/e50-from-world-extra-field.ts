// PROBE 50: a second field inside a `{ world }` origin. Constraint checking
// runs no excess-property check, so `{ world: "a human", role: "reviewer" }`
// structurally satisfies `{ world: string }` — the author would have written a
// `role` that every reader silently drops, and the sentence a report builds
// would be missing the half the author thought they had declared. A role is ONE
// fact and it is `world`; `__fromWorldCannotAlsoDeclare` names the offender.
// @expect-error: TS2322
import { defineChart } from "../graph";
export const g = defineChart({
  events: {
    X: { scope: "edges", from: "cmd" },
    UNBLOCKED: {
      scope: "edges",
      from: { world: "a human", role: "reviewer" }, // ← `role` is not a field
    },
  },
  states: {
    only: {
      a: { initial: true, on: { X: "b", UNBLOCKED: "a" } },
      b: {},
    },
  },
});
