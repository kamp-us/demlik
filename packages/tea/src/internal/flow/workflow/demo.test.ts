/**
 * Saga demo as an integration test (#127, story 5 of epic #118). The runnable
 * demo (`./demo`) doubles as the acceptance test for the Saga engine: it drives
 * the canonical `order → charge → reserve → ship` transaction along both paths
 * over the #124 core + #125 reverse-order compensation, and asserts each one.
 *
 * Each `it` maps to a #127 acceptance criterion:
 *   - "happy path drives order→charge→reserve→ship to completed" .. → "the happy
 *      path runs every step and settles `completed`"
 *   - "forced failure triggers reverse-order compensation" ........ → "the
 *      forced-failure path rolls back in STRICT REVERSE and settles
 *      `failed_compensated`"
 *   - "the demo is deterministic / reproducible" .................. → "re-running
 *      yields an identical result + trace"
 *
 * Globals are NOT enabled in vitest.config.ts (describe/it/expect imported);
 * fast-check's seed is pinned by `src/test-setup.ts` for the reproducibility fuzz.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  demoIsReproducible,
  HAPPY_PATH,
  narrateDemo,
  runDemo,
  runScenario,
  SAGA_STEPS,
  SHIP_FAILS,
} from "./demo";

describe("Saga demo — happy path drives order → charge → reserve → ship", () => {
  it("runs every step and settles `completed` (happy path)", () => {
    const { happy } = runDemo();
    // All four forward steps committed, in forward order.
    expect(happy.committed).toEqual(["order", "charge", "reserve", "ship"]);
    expect(happy.status).toBe("completed");
    // Nothing was rolled back — the happy path never compensates.
    expect(happy.compensated).toEqual([]);
    // The workflow carries the final step's output.
    expect(happy.output?.op).toBe("ship");
  });

  it("folds exactly one successful activity result per step (happy path)", () => {
    const happy = runScenario(HAPPY_PATH);
    // Four steps → four `activity_ok` folds, no failures, no compensations.
    expect(happy.trace).toHaveLength(SAGA_STEPS.length);
    expect(happy.trace.every((t) => t.kind === "activity_ok")).toBe(true);
    // Only the LAST fold settles `completed`; the earlier ones stay `running`.
    expect(happy.trace.map((t) => t.status)).toEqual([
      "running",
      "running",
      "running",
      "completed",
    ]);
  });
});

describe("Saga demo — forced failure rolls back in reverse and settles failed_compensated", () => {
  it("settles `failed_compensated` when `ship` fails", () => {
    const { rollback } = runDemo();
    expect(rollback.status).toBe("failed_compensated");
    // The three steps before `ship` committed; `ship` never did.
    expect(rollback.committed).toEqual(["order", "charge", "reserve"]);
    expect(rollback.committed).not.toContain("ship");
  });

  it("runs the committed steps' compensations in STRICT REVERSE order", () => {
    const { rollback } = runDemo();
    // The headline #125/#127 property: the unwind walks the committed prefix
    // from its tail toward index 0.
    expect(rollback.compensated).toEqual(["reserve", "charge", "order"]);
    // … which is exactly the reverse of what committed.
    expect(rollback.compensated).toEqual([...rollback.committed].reverse());
  });

  it("traces the forward failure then each reverse compensation (forced failure)", () => {
    const rollback = runScenario(SHIP_FAILS);
    // order✓ charge✓ reserve✓ ship✗ → release↩ refund↩ cancel-order↩
    expect(rollback.trace.map((t) => t.kind)).toEqual([
      "activity_ok", // order
      "activity_ok", // charge
      "activity_ok", // reserve
      "activity_err", // ship — the forced failure
      "compensation_ok", // reserve  (reverse walk begins)
      "compensation_ok", // charge
      "compensation_ok", // order
    ]);
    // The failure pivots the workflow into `compensating`, then each
    // compensation advances the unwind, ending at `failed_compensated`.
    expect(rollback.trace.map((t) => t.status)).toEqual([
      "running",
      "running",
      "running",
      "compensating",
      "compensating",
      "compensating",
      "failed_compensated",
    ]);
  });

  it("never compensates a step that did not commit (ship is not undone)", () => {
    const { rollback } = runDemo();
    // `ship` failed forward, so it owns no completed step — it is not in the
    // unwind set, and `cancel-shipment` never runs.
    expect(rollback.compensated).not.toContain("ship");
  });
});

describe("Saga demo — deterministic reproducibility", () => {
  it("is byte-identically reproducible (same drive → same result)", () => {
    const result = runDemo();
    expect(demoIsReproducible(result)).toBe(true);
  });

  it("two independent runs produce identical results + traces", () => {
    const a = runDemo();
    const b = runDemo();
    expect(b).toEqual(a);
    expect(b.happy.trace).toEqual(a.happy.trace);
    expect(b.rollback.trace).toEqual(a.rollback.trace);
  });

  it("re-running each scenario on a fresh workflow is byte-identical", () => {
    // Drive each scenario through the raw reducer a handful of times under a
    // pinned-seed fast-check loop — every run agrees with the first (the replay
    // identity the engine's determinism contract pins, applied to the demo).
    const happyBaseline = runScenario(HAPPY_PATH);
    const rollbackBaseline = runScenario(SHIP_FAILS);
    fc.assert(
      fc.property(fc.constant(null), () => {
        expect(runScenario(HAPPY_PATH)).toEqual(happyBaseline);
        expect(runScenario(SHIP_FAILS)).toEqual(rollbackBaseline);
      }),
    );
  });
});

describe("Saga demo — narration", () => {
  it("renders a readable narrative naming both paths and the reverse rollback", () => {
    const text = narrateDemo(runDemo());
    expect(text).toContain("Saga rollback demo");
    // The narration surfaces the reverse-order rollback outcome explicitly.
    expect(text).toContain("reverse-order rollback: OK");
    expect(text).toMatch(
      /rolled back \(reverse\):\s*\[reserve → charge → order\]/,
    );
    // Print the live narration so running this file IS the runnable demo
    // (`pnpm --filter @demlik/tea demo:saga` runs exactly this test).
    console.log(`\n${text}\n`);
  });
});
