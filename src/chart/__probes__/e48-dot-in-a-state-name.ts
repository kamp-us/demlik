// PROBE 48: a dot in a STATE name. An edge key IS `${state}.${event}` and
// `Assigns` splits it at the FIRST dot, so `"a.b"` re-partitions every key it
// appears in — `"a.b.X"` reads as state `"a"`, event `"b.X"`. It already failed
// closed, but the diagnostic named nothing (`Type '(s: any) => …' is not
// assignable to type 'never'`), which is why the repo's own fixture reaches for
// `"human:cp-approval"`: the constraint was known and worked around by hand.
// `Total<C>` already banned the dot in a FOREIGN EVENT name for the same reason;
// this is that rule applied to the other half of the key.
// @expect-error: TS2322
import { defineChart } from "../graph";
export const g = defineChart({
  events: { X: { scope: "edges" } },
  states: { only: { "a.b": { initial: true, on: { X: "c" } }, c: {} } },
});
