// PROBE 26: an `assign` entry for a CELL edge. The cell returns the whole next
// state, so this builder could never run — `Assigns` is keyed by the declared
// edges MINUS the cell edges, which makes the dead entry an excess property
// tsc names, rather than a function that silently never fires.
import type { Assigns } from "../graph";
import { type FG, type FMsg, type FState, assign } from "../resilient-fetch-chart";
export const bad: Assigns<FG, FState, FMsg> = {
  ...assign,
  "idle.fetch": (s) => s,
};
