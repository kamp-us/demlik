import { delta } from "./d.js";
import { epsilon } from "./e.js";

export function zeta(n: number): number {
  return n > 0 ? delta(n - 1) + epsilon(n - 1) : 0;
}
