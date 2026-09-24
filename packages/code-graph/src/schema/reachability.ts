import { z } from "zod";

export const UnreachableCategorySchema = z.enum(["dead", "only-called-from-tests"]);
export type UnreachableCategory = z.infer<typeof UnreachableCategorySchema>;

export const UnreachableSymbolSchema = z.object({
  id: z.string(),
  file: z.string(),
  startLine: z.number(),
  category: UnreachableCategorySchema,
  testReferences: z.array(z.string()),
});
export type UnreachableSymbol = z.infer<typeof UnreachableSymbolSchema>;

export const WithheldReasonSchema = z.enum([
  "referenced-in-non-test-file",
  "public-entry-surface",
  "test-support-surface",
]);
export type WithheldReason = z.infer<typeof WithheldReasonSchema>;

export const WithheldSymbolSchema = z.object({
  id: z.string(),
  reason: WithheldReasonSchema,
});
export type WithheldSymbol = z.infer<typeof WithheldSymbolSchema>;

export const UnguardedEffectSchema = z.object({
  effectId: z.string(),
  file: z.string(),
  startLine: z.number(),
  entryId: z.string(),
  path: z.array(z.string()),
});
export type UnguardedEffect = z.infer<typeof UnguardedEffectSchema>;

export const ReachabilityReportSchema = z.object({
  entryCount: z.number(),
  exportedCount: z.number(),
  reachableCount: z.number(),
  unreachable: z.array(UnreachableSymbolSchema),
  withheld: z.array(WithheldSymbolSchema),
  unguarded: z.array(UnguardedEffectSchema),
});
export type ReachabilityReport = z.infer<typeof ReachabilityReportSchema>;
