import { z } from "zod";
import type { BoundaryKind } from "../violation.js";

// The two rules about who declares and who writes a feature's tables. A rules file turns each on by
// naming it in `tableOwnership`; a kind it does not name does not run, so a release that adds a kind
// never fails the merge gate of a repo that did not ask for it.
export const TABLE_KINDS = [
  "table-declared-outside-tables",
  "table-written-outside-owner",
] as const satisfies readonly BoundaryKind[];

export type TableKind = (typeof TABLE_KINDS)[number];

// The one key of the rules file about tables, spread into `BoundaryRulesSchema`.
//  - `tableOwnership`: the kinds that run, empty by default.
export const TABLE_KEYS = {
  tableOwnership: z.array(z.enum(TABLE_KINDS)).default([]),
};

export type TableRules = z.infer<z.ZodObject<typeof TABLE_KEYS>>;
