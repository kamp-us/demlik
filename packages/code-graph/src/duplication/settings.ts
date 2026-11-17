import { z } from "zod";

export const DuplicationSettingsSchema = z
  .object({
    cloneMinNodes: z.number().int().positive().default(14),
    cloneMinFiles: z.number().int().min(3).default(3),
    cloneIgnoreIdentifiers: z.boolean().default(false),
    cloneIgnoreLiterals: z.boolean().default(false),
    clumpMinValues: z.number().int().min(3).default(3),
    clumpMinSites: z.number().int().min(3).default(3),
  })
  .strict();

export type DuplicationSettings = z.infer<typeof DuplicationSettingsSchema>;
