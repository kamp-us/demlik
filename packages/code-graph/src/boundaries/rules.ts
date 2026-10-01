import { z } from "zod";

// The per-scope count file the ledger replaced. `--boundaries --migrate-ceilings` reads it once,
// and the gate refuses to run while it stands without a ledger.
export const LEGACY_CEILINGS_FILENAME = "boundary-ceilings.json";

const FolderSchema = z
  .string()
  .min(1)
  .regex(/^[^/]+$/, "a top-level folder under src/, not a path");

// `{ "<scope>": { "<door>": ["<scope-relative owner file>", …] } }`. The door names and the owner
// files are judged where the file is read (`resolveBoundaryRules`) and where the scope is loaded.
const DoorsSchema = z.record(
  z.string().min(1),
  z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
);

export const BoundaryRulesSchema = z
  .object({
    features: z.record(z.string().min(1), z.array(FolderSchema).min(1)).default({}),
    lib: z.array(FolderSchema).default(["lib"]),
    contracts: z.array(z.string().min(1)).default([]),
    doors: DoorsSchema.default({}),
  })
  .strict();
export type BoundaryRules = z.infer<typeof BoundaryRulesSchema>;
