import assert from "node:assert/strict";
import test from "node:test";
import { evidenceGaps } from "./coverage.mjs";

test("capability evidence must call the compiled public path, not merely pass a named case", () => {
  const mapping = {
    rust: { symbols: ["demlik_tea::core::fold_msgs"] },
    cases: ["fold"],
  };
  assert.deepEqual(
    evidenceGaps(
      mapping,
      new Map([["fold", new Set(["demlik_tea::core::fold_msgs"])]]),
    ),
    [],
  );
  assert.notEqual(
    evidenceGaps(mapping, new Map([["fold", new Set(["demlik_tea::replay"])]]))
      .length,
    0,
  );
  assert.notEqual(
    evidenceGaps(
      { ...mapping, rust: { symbols: ["demlik_tea::does_not_exist"] } },
      new Map([["fold", new Set(["demlik_tea::core::fold_msgs"])]]),
    ).length,
    0,
  );
  assert.notEqual(evidenceGaps(mapping, new Map()).length, 0);
});
