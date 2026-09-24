import { z } from "zod";

export const LayerSchema = z
  .object({
    name: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type Layer = z.infer<typeof LayerSchema>;

export const AllowedEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    sites: z.number().int().positive(),
    reason: z.string().min(1),
  })
  .strict();
export type AllowedEdge = z.infer<typeof AllowedEdgeSchema>;

export const LayerRulesSchema = z
  .object({
    // A layer stack is repo-specific, so none ships: an absent `layers` parses to `[]`, which
    // `resolveLayerRules` refuses, while an explicit stack still needs at least two layers.
    layers: z.array(LayerSchema).min(2).default([]),
    allowed: z.array(AllowedEdgeSchema).default([]),
  })
  .strict();
export type LayerRules = z.infer<typeof LayerRulesSchema>;
