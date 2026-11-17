import { describe, expect, it } from "vitest";
import {
  type JournalKitFactory,
  journalConformance,
  type KitOptions,
} from "./conformance";

export function describeJournalConformance(
  label: string,
  make: JournalKitFactory,
  options: KitOptions,
): void {
  describe(`Journal conformance: ${label}`, { timeout: 180_000 }, () => {
    it("matches the model in every applicable K1–K8 case", async () => {
      const start = options.now();
      const results = await journalConformance(make, options);
      console.info(
        JSON.stringify({
          driver: label,
          elapsedMs: options.now() - start,
          results,
        }),
      );
      expect(results.filter((result) => result.status === "failed")).toEqual(
        [],
      );
    });
  });
}
