import { named } from "./lib.js";

// Not exported and never called, so no walk starts here; it only names `named`.
function useNamed(): number {
  return named();
}
