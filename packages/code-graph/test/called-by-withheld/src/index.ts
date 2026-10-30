import { a } from "./chain/one.js";

// The package's public surface: withheld as public-entry-surface.
export function publicEntry(): number {
  return a();
}
