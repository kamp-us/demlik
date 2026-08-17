// PROBE 5: an event used in `on` that is not in the declared payload map.
import { type MsgOf, defineGraph } from "../graph";
const g = defineGraph({
  queued: { on: { WIP: "build", ESCALATE: "build" } }, // ← ESCALATE has no payload
  build: {},
});
export type Msg = MsgOf<
  typeof g,
  { WIP: { readonly at: number } }
>;
