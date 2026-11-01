import { alpha } from "./a.js";
import { gamma } from "./c.js";

export function beta(n: number): number {
  return n > 0 ? alpha(n - 1) + gamma(n - 1) : 0;
}
