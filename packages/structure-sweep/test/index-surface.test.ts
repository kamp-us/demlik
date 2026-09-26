import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

// The inventory command's glob helpers, input schemas and lever constants are internal: once
// published, every name in the index is a semver promise (#477).
const INVENTORY_INTERNALS = [
  "anyGlob",
  "globMatcher",
  "readSource",
  "ConsolidateInput",
  "GraphInput",
  "PairInput",
  "PairsInput",
  "UnreachableInput",
  "LEVERS",
  "LEVER_ORDER",
  "SAME_DECISION_FLOOR",
  "SHARED_HELPER_FLOOR",
  "SCOPE_DEPTH",
  "DEFAULT_GENERIC_NAMES",
  "topLevelScope",
] as const;

describe("the package index", () => {
  it("exports the inventory entry points", () => {
    expect(typeof api.buildInventory).toBe("function");
    expect(typeof api.renderInventory).toBe("function");
  });

  it.each(INVENTORY_INTERNALS)("keeps %s internal", (name) => {
    expect(Object.keys(api)).not.toContain(name);
  });
});
