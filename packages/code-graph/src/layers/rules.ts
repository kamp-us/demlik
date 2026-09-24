import { z } from "zod";
import { ALLOWED_EDGES } from "./allowed.js";

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

const DEFAULT_LAYERS: readonly Layer[] = [
  {
    name: "surface",
    paths: ["apps/web", "apps/widget", "apps/docs", "packages/cli"],
  },
  {
    name: "service",
    paths: ["services"],
  },
  {
    name: "domain",
    paths: [
      "services/*/src/domain",
      "packages/a11y",
      "packages/widget-engine",
      "packages/widget-runtime",
      "packages/hands-machine",
      "packages/machine-auth",
      "packages/sr-hands",
      "packages/sr-tools",
    ],
  },
  {
    name: "storage",
    paths: ["services/*/src/drizzle"],
  },
  {
    name: "contract",
    paths: [
      "packages/a11y-contract",
      "packages/telemetry-contract",
      "packages/audit-protocol",
      "packages/stdlib",
    ],
  },
];

export const LayerRulesSchema = z
  .object({
    layers: z
      .array(LayerSchema)
      .min(2)
      .default([...DEFAULT_LAYERS]),
    allowed: z.array(AllowedEdgeSchema).default([...ALLOWED_EDGES]),
  })
  .strict();
export type LayerRules = z.infer<typeof LayerRulesSchema>;
