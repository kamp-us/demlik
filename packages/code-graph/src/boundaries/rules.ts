import { z } from "zod";

// The per-scope count file the ledger replaced. `--boundaries --migrate-ceilings` reads it once,
// and the gate refuses to run while it stands without a ledger.
export const LEGACY_CEILINGS_FILENAME = "boundary-ceilings.json";

const FolderSchema = z
  .string()
  .min(1)
  .regex(/^[^/]+$/, "a top-level folder under src/, not a path");

export const BoundaryRulesSchema = z
  .object({
    features: z.record(z.string().min(1), z.array(FolderSchema).min(1)).default({}),
    lib: z.array(FolderSchema).default(["lib"]),
    contracts: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type BoundaryRules = z.infer<typeof BoundaryRulesSchema>;
