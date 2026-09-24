import { z } from "zod";

export const CEILINGS_FILENAME = "boundary-ceilings.json";

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
