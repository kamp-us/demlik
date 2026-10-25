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

test("passing calls cannot erase a measured unresolved parity gap", () => {
  const mapping = {
    rust: { symbols: ["demlik_tea::work_queue::QueueClient::enqueue"] },
    cases: ["sequential"],
    knownGaps: ["Concurrent store ordering remains unresolved"],
  };
  const evidence = new Map([["sequential", new Set(mapping.rust.symbols)]]);
  assert.deepEqual(evidenceGaps(mapping, evidence), [
    "Known parity gap: Concurrent store ordering remains unresolved",
  ]);
});
