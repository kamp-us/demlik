import { delta } from "./d.js";
import { zeta } from "./f.js";

export function epsilon(n: number): number {
  return n > 0 ? delta(n - 1) + zeta(n - 1) : 0;
}
