import { epsilon } from "./e.js";
import { zeta } from "./f.js";

export function delta(n: number): number {
  return n > 0 ? epsilon(n - 1) + zeta(n - 1) : 0;
}
