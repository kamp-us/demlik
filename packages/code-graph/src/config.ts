import fs from "node:fs";
import type { z } from "zod";
import { type BoundaryRules, BoundaryRulesSchema } from "./boundaries/rules.js";
import { type CollapseSettings, CollapseSettingsSchema } from "./collapse/settings.js";
import { type CommentCeilings, CommentCeilingsSchema } from "./comments/ceilings.js";
import { type NodeKindRules, NodeKindRulesSchema } from "./kinds/rules.js";
import { type LayerRules, LayerRulesSchema } from "./layers/rules.js";
import { type Thresholds, ThresholdsSchema } from "./schema.js";

export type Reporter = (message: string) => void;

function loadOverrides<T extends object>(
  file: string,
  schema: z.ZodType<Partial<T>>,
  defaults: T,
  report: Reporter,
): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    report(`cannot read config file "${file}".`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    report(`config file "${file}" is not valid JSON.`);
    return null;
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.join(".") || "(root)";
    report(`invalid config in "${file}": ${where}: ${issue?.message ?? "parse error"}.`);
    return null;
  }
  return { ...defaults, ...result.data };
}

export function resolveThresholds(file: string | undefined, report: Reporter): Thresholds | null {
  const defaults = ThresholdsSchema.parse({});
  if (file === undefined) return defaults;
  return loadOverrides(file, ThresholdsSchema.partial(), defaults, report);
}

export function resolveCollapseSettings(
  file: string | undefined,
  report: Reporter,
): CollapseSettings | null {
  const defaults = CollapseSettingsSchema.parse({});
  if (file === undefined) return defaults;
  return loadOverrides(file, CollapseSettingsSchema.partial(), defaults, report);
}

export function resolveNodeKindRules(
  file: string | undefined,
  report: Reporter,
): NodeKindRules | null {
  const defaults = NodeKindRulesSchema.parse({});
  const rules =
    file === undefined
      ? defaults
      : loadOverrides(file, NodeKindRulesSchema.partial(), defaults, report);
  if (rules === null) return null;
  for (const group of Object.values(rules)) {
    for (const sources of Object.values(group)) {
      for (const source of sources) {
        try {
          new RegExp(source);
        } catch {
          report(`invalid regular expression in node-kind rules: ${source}`);
          return null;
        }
      }
    }
  }
  return rules;
}

export function resolveLayerRules(file: string | undefined, report: Reporter): LayerRules | null {
  const defaults = LayerRulesSchema.parse({});
  const rules =
    file === undefined
      ? defaults
      : loadOverrides(file, LayerRulesSchema.partial(), defaults, report);
  if (rules === null) return null;
  if (rules.layers.length === 0) {
    report("no layer stack declared; pass --layer-rules <file> with a `layers` array.");
    return null;
  }
  const names = new Set<string>();
  const patterns = new Map<string, string>();
  for (const layer of rules.layers) {
    if (names.has(layer.name)) {
      report(`duplicate layer name "${layer.name}" in the layer declaration.`);
      return null;
    }
    names.add(layer.name);
    for (const pattern of layer.paths) {
      const owner = patterns.get(pattern);
      if (owner !== undefined) {
        report(`path "${pattern}" is declared in both "${owner}" and "${layer.name}".`);
        return null;
      }
      patterns.set(pattern, layer.name);
    }
  }
  return rules;
}

export function resolveCommentCeilings(
  file: string | undefined,
  report: Reporter,
): CommentCeilings | null {
  const defaults = CommentCeilingsSchema.parse({});
  if (file === undefined) return defaults;
  return loadOverrides(file, CommentCeilingsSchema.partial(), defaults, report);
}

export function resolveBoundaryRules(
  file: string | undefined,
  report: Reporter,
): BoundaryRules | null {
  const defaults = BoundaryRulesSchema.parse({});
  const rules =
    file === undefined
      ? defaults
      : loadOverrides(file, BoundaryRulesSchema.partial(), defaults, report);
  if (rules === null) return null;
  const lib = new Set(rules.lib);
  for (const [scope, features] of Object.entries(rules.features)) {
    const seen = new Set<string>();
    for (const feature of features) {
      if (seen.has(feature)) {
        report(`feature "${feature}" is declared twice in "${scope}".`);
        return null;
      }
      if (lib.has(feature)) {
        report(`"${feature}" in "${scope}" is declared as both a feature and lib.`);
        return null;
      }
      seen.add(feature);
    }
  }
  return rules;
}
