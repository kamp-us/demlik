import { beta } from "./b.js";
import { gamma } from "./c.js";

export function alpha(n: number): number {
  return n > 0 ? beta(n - 1) + gamma(n - 1) : 0;
}
