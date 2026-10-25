import { z } from "zod";

export const count = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const layer = z
  .object({ name: z.string(), paths: z.array(z.string()) })
  .strict();
export const allowed = z
  .object({
    from: z.string(),
    to: z.string(),
    sites: count,
    reason: z.string(),
  })
  .strict();
export const rank = z.object({ name: z.string(), rank: count }).strict();
export const edge = z
  .object({
    from: z.string(),
    fromLine: count,
    fromLayer: z.string(),
    to: z.string(),
    toLine: count,
    toLayer: z.string(),
    specifier: z.string(),
    typeOnly: z.boolean(),
  })
  .strict();
export const census = z
  .object({
    down: count,
    sideways: count,
    up: count,
    unlayered: count,
    external: count,
    unresolved: count,
  })
  .strict();
export const report = z
  .object({
    layers: z.array(z.string()),
    filesScanned: count,
    census,
    violations: z.array(edge),
    unresolved: z.array(z.string()),
  })
  .strict();
