import { z } from "zod";
import { DeclarationKindSchema, EntryReachSchema } from "./core.js";

export const UnreachableCategorySchema = z.enum(["dead", "only-called-from-tests"]);
export type UnreachableCategory = z.infer<typeof UnreachableCategorySchema>;

// An export no other loaded file uses still runs, so it never joins `unreachable[]`, whose
// categories all mean "never runs". It is its own kind of finding, gated through the same ledger.
export const UNUSED_EXPORT = "unused-export";
export const UnreachableFindingKindSchema = z.enum([
  ...UnreachableCategorySchema.options,
  UNUSED_EXPORT,
]);
export type UnreachableFindingKind = z.infer<typeof UnreachableFindingKindSchema>;

// `function` for every exported function node (declaration, arrow or function expression); a
// declaration node's own kind otherwise.
export const ExportedSymbolKindSchema = z.enum(["function", ...DeclarationKindSchema.options]);
export type ExportedSymbolKind = z.infer<typeof ExportedSymbolKindSchema>;

// An exported symbol outside the public surface that no other loaded file, test files included,
// imports, re-exports or otherwise uses by the type checker's resolution.
export const UnusedExportSchema = z.object({
  id: z.string(),
  file: z.string(),
  startLine: z.number(),
  symbolKind: ExportedSymbolKindSchema,
});
export type UnusedExport = z.infer<typeof UnusedExportSchema>;

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
  "called-by-withheld",
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
  reach: EntryReachSchema,
});
export type UnguardedEffect = z.infer<typeof UnguardedEffectSchema>;

export const ReachabilityReportSchema = z.object({
  entryCount: z.number(),
  exportedCount: z.number(),
  reachableCount: z.number(),
  unreachable: z.array(UnreachableSymbolSchema),
  withheld: z.array(WithheldSymbolSchema),
  unusedExports: z.array(UnusedExportSchema),
  unguarded: z.array(UnguardedEffectSchema),
});
export type ReachabilityReport = z.infer<typeof ReachabilityReportSchema>;
