// PROBE 46: one computed key whose type is the bare `string`. It gives
// `states.only` an INDEX SIGNATURE, `StateName<C>` degenerates from a union of
// literals to `string`, and every check downstream of it stops checking: the
// bogus target `"totally-not-a-state"` is accepted, `EdgeKey<C>` degenerates,
// and `compile(g, { assign: {} })` demands no builders at all. The chart was
// not weakened, it was switched OFF, and nothing said so.
//
// What must KEEP working, and is pinned in `assert.test-d.ts`: a LITERAL
// computed key (`const NAME = "a"`) and a spread of another object. Both retain
// their literal types, so neither is degenerate and neither is refused.
// @expect-error: TS2345
import { defineChart } from "../graph";

const prefix = "a" as string;
export const g = defineChart({
  events: { X: { scope: "edges" } },
  states: {
    only: { [prefix]: { initial: true, on: { X: "totally-not-a-state" } } },
  },
});
