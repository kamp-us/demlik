import { alpha } from "./a.js";
import { beta } from "./b.js";
import { delta } from "./d.js";

export function gamma(n: number): number {
  return n > 0 ? alpha(n - 1) + beta(n - 1) + delta(n - 1) : 0;
}
