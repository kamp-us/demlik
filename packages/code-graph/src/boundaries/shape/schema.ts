import { z } from "zod";
import type { BoundaryKind } from "../violation.js";

// The two rules about the shape of a hexagonal feature's own files. A rules file turns each on by
// naming it in `applicationShape`; a kind it does not name does not run, so a release that adds a
// kind never fails the merge gate of a repo that did not ask for it.
export const SHAPE_KINDS = [
  "index-not-exports-only",
  "application-import-outside-allowlist",
] as const satisfies readonly BoundaryKind[];

export type ShapeKind = (typeof SHAPE_KINDS)[number];

// `{ "<scope>": { driven: ["<scope-relative file>", …], decidedBy: ["<library type>", …] } }`: the
// driven files a driving adapter may import beside a library of one of these types, which is where
// the decision lives. The files and the types are judged where the file is read
// (`shapeDeclarationIssue`) and where the scope is loaded (`unknownDrivenFiles`).
const ReadAllowanceSchema = z.record(
  z.string().min(1),
  z
    .object({
      driven: z.array(z.string().min(1)),
      decidedBy: z.array(z.string().min(1)),
    })
    .strict(),
);

// The six keys of the rules file about a feature's own files, spread into `BoundaryRulesSchema`.
//  - `applicationShape`: the kinds that run, empty by default.
//  - `applicationMayImport`: library types an `application/` file may import (needs B16 listed).
//  - `pureDependencies`: package globs an `application/` file may import (needs B16 listed).
//  - `testFiles`: globs of the files that are tests, which sit in no zone.
//  - `strictDriving`: scopes where B9 judges every catalog door, not only the declared ones.
//  - `readAllowance`: per scope, the driven files a driving adapter may read through.
export const SHAPE_KEYS = {
  applicationShape: z.array(z.enum(SHAPE_KINDS)).default([]),
  applicationMayImport: z.array(z.string().min(1)).default([]),
  pureDependencies: z.array(z.string().min(1)).default([]),
  testFiles: z.array(z.string().min(1)).default([]),
  strictDriving: z.array(z.string().min(1)).default([]),
  readAllowance: ReadAllowanceSchema.default({}),
};

export type ShapeRules = z.infer<z.ZodObject<typeof SHAPE_KEYS>>;

// Whether the rules file declares a read allowance: the one key that reads the repo (the wrangler
// configs), so the run lists the repo once for it.
export function declaresReadAllowance(rules: Pick<ShapeRules, "readAllowance">): boolean {
  return Object.keys(rules.readAllowance).length > 0;
}
