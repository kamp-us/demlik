// PROBE 61: a lane region whose guarded edge is not the retry guard.
//
// The fold walks EVERY guarded edge with one inline predicate, `retries <
// maxRetries`, because that is the only guard a `workflow.json` can mean — the
// two-arm array IS the retry guard and the guard NAME in the document is inert
// data. A `defineChart` literal, though, guards on whatever its author wrote,
// and the BODY lives in `Parts`, which `defineLane` never sees: there is no
// seam at which the fold could be handed it.
//
// So `amount < 100` driven with `amount: 5000` RAN to `declined` and FOLDED to
// `captured` — a tripped run reported complete, with a `retries: 1/2` invented
// on a chart that has no retry concept. A lane that cannot be folded is refused
// at the door rather than described wrongly in a report, and the marker names
// the contract the fold's predicate is written against: the region's `ctx`
// carries the two numbers it reads.
// @expect-error: TS2345
import { defineChart, ty } from "../graph";
import { defineLane } from "../lane/structure";

const payment = defineChart({
  ctx: ty<{ readonly amount: number }>(),
  events: { CHARGE: { scope: "edges" } },
  states: {
    only: {
      pending: {
        initial: true,
        on: {
          CHARGE: { target: "captured", when: "small", otherwise: "declined" },
        },
      },
      captured: { end: true },
      declined: { end: "error" },
    },
  },
});

export const epic = defineLane({
  phases: { phase1: { pay: payment } },
  terminals: { complete: "complete", tripped: "tripped" },
});
