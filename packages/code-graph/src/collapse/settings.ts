import { z } from "zod";

export const CollapseSettingsSchema = z
  .object({
    minSignals: z.number().int().min(2).max(4).default(2),
    minLoc: z.number().int().nonnegative().default(5),
    minComplexity: z.number().int().nonnegative().default(2),

    shapeLocSlack: z.number().int().nonnegative().default(3),
    shapeLocRatio: z.number().nonnegative().default(0.2),
    shapeComplexitySlack: z.number().int().nonnegative().default(1),
    shapeNestingSlack: z.number().int().nonnegative().default(1),

    minSetSize: z.number().int().nonnegative().default(2),
    calleeJaccard: z.number().min(0).max(1).default(0.5),
    callerJaccard: z.number().min(0).max(1).default(0.5),

    nameOverlap: z.number().min(0).max(1).default(0.5),
    nameMinTokenLength: z.number().int().nonnegative().default(4),

    costCallerWeight: z.number().nonnegative().default(1),
    costPackageWeight: z.number().nonnegative().default(1),
    costCrossPackageWeight: z.number().nonnegative().default(2),
    costEffectWeight: z.number().nonnegative().default(1),

    maxBlockSize: z.number().int().nonnegative().default(120),

    partialMinPrefix: z.number().int().min(2).default(3),
    partialMinSharedConstants: z.number().int().min(1).default(1),
    partialMaxBlockSize: z.number().int().nonnegative().default(40),
  })
  .strict();

export type CollapseSettings = z.infer<typeof CollapseSettingsSchema>;
