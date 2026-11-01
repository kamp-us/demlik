import { z } from "zod";

export const LayerSchema = z
  .object({
    name: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1),
    // Absent: anything below may be imported. Present: only these, so `[]` leaves only the layer itself.
    imports: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type Layer = z.infer<typeof LayerSchema>;

/** The first `imports` entry that names no layer, or a layer above the one declaring it. */
export function importsIssue(layers: readonly Layer[]): string | null {
  const ranks = new Map(layers.map((layer, rank) => [layer.name, rank]));
  for (const [rank, layer] of layers.entries()) {
    for (const target of layer.imports ?? []) {
      const targetRank = ranks.get(target);
      if (targetRank === undefined) {
        return `layer "${layer.name}" imports "${target}", which is not a declared layer.`;
      }
      if (targetRank < rank) {
        return `layer "${layer.name}" imports "${target}", which is above it; \`imports\` cannot grant an upward edge.`;
      }
    }
  }
  return null;
}

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
