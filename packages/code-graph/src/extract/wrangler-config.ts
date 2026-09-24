import fs from "node:fs";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { BindingKind } from "../schema.js";
import { listVisibleFiles } from "./project.js";

const ServiceBindingSchema = z.object({
  binding: z.string(),
  service: z.string(),
  entrypoint: z.string().optional(),
});

const DurableObjectBindingSchema = z.object({
  name: z.string(),
  class_name: z.string(),
  script_name: z.string().optional(),
});

const WorkflowBindingSchema = z.object({
  binding: z.string(),
  class_name: z.string(),
  script_name: z.string().optional(),
});

const WranglerConfigSchema = z.object({
  name: z.string().optional(),
  main: z.string().optional(),
  services: z.array(ServiceBindingSchema).catch([]).default([]),
  workflows: z.array(WorkflowBindingSchema).catch([]).default([]),
  durable_objects: z
    .object({ bindings: z.array(DurableObjectBindingSchema).catch([]).default([]) })
    .catch({ bindings: [] })
    .default({ bindings: [] }),
  vars: z.record(z.string(), z.unknown()).catch({}).default({}),
  secrets: z
    .object({ required: z.array(z.string()).catch([]).default([]) })
    .catch({ required: [] })
    .default({ required: [] }),
});

export type BindingDecl = {
  kind: BindingKind;
  binding: string;
  targetService: string;
  targetClass: string;
};

export type ServiceManifest = {
  service: string;
  dir: string;
  configFile: string;
  main: string | null;
  bindings: BindingDecl[];
  envKeys: string[];
  bindingNames: string[];
  devVarsKeys: string[];
  devVarsFiles: string[];
};

export type BindingCatalog = {
  manifests: ServiceManifest[];
  unparsedConfigs: string[];
};

const CONFIG_BASENAMES = new Set(["wrangler.json", "wrangler.jsonc", "wrangler.toml"]);
function rel(base: string, absolute: string): string {
  return path.relative(base, absolute).split(path.sep).join("/");
}

export function findWranglerConfigs(repoRoot: string): string[] {
  return listVisibleFiles(repoRoot, (f) => CONFIG_BASENAMES.has(path.posix.basename(f))).map((f) =>
    path.join(repoRoot, f),
  );
}

function readConfigDocument(absolute: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
  try {
    return absolute.endsWith(".toml") ? parseToml(raw) : parseJsonc(raw);
  } catch {
    return null;
  }
}

function compareBindings(a: BindingDecl, b: BindingDecl): number {
  return (
    a.binding.localeCompare(b.binding) ||
    a.targetService.localeCompare(b.targetService) ||
    a.targetClass.localeCompare(b.targetClass)
  );
}

function declaredBindings(
  config: z.infer<typeof WranglerConfigSchema>,
  self: string,
): BindingDecl[] {
  const out: BindingDecl[] = [];
  for (const s of config.services) {
    out.push({
      kind: "service",
      binding: s.binding,
      targetService: s.service,
      targetClass: s.entrypoint ?? "default",
    });
  }
  for (const d of config.durable_objects.bindings) {
    out.push({
      kind: "durable-object",
      binding: d.name,
      targetService: d.script_name ?? self,
      targetClass: d.class_name,
    });
  }
  for (const w of config.workflows) {
    out.push({
      kind: "workflow",
      binding: w.binding,
      targetService: w.script_name ?? self,
      targetClass: w.class_name,
    });
  }
  return out.sort(compareBindings);
}

function collectBindingNames(value: unknown, topLevel = true): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => collectBindingNames(v, false));
  if (value === null || typeof value !== "object") return [];
  const out: string[] = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (topLevel && key === "env") continue;
    if (key === "binding" && typeof v === "string") out.push(v);
    else out.push(...collectBindingNames(v, false));
  }
  return out;
}

function sortedUnique(names: readonly string[]): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

const DEV_VARS_BASENAMES = [".dev.vars", ".dev.vars.example"] as const;

function parseDevVarsKeys(raw: string): string[] {
  const keys: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    keys.push(trimmed.slice(0, eq).trim());
  }
  return keys;
}

function devVars(configDir: string): { keys: string[]; files: string[] } {
  const files: string[] = [];
  const keys: string[] = [];
  for (const basename of DEV_VARS_BASENAMES) {
    const absolute = path.join(configDir, basename);
    let raw: string;
    try {
      raw = fs.readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    files.push(basename);
    keys.push(...parseDevVarsKeys(raw));
  }
  return { keys: sortedUnique(keys), files: files.sort((a, b) => a.localeCompare(b)) };
}

export function loadBindingCatalog(repoRoot: string): BindingCatalog {
  const manifests: ServiceManifest[] = [];
  const unparsedConfigs: string[] = [];

  for (const absolute of findWranglerConfigs(repoRoot)) {
    const configFile = rel(repoRoot, absolute);
    const document = readConfigDocument(absolute);
    const parsed = document === null ? null : WranglerConfigSchema.safeParse(document);
    if (parsed === null || !parsed.success) {
      unparsedConfigs.push(configFile);
      continue;
    }
    const dir = rel(repoRoot, path.dirname(absolute));
    const service = parsed.data.name ?? path.basename(path.dirname(absolute));
    const main = parsed.data.main ?? null;
    const { keys: devVarsKeys, files: devVarsFiles } = devVars(path.dirname(absolute));
    manifests.push({
      service,
      dir,
      configFile,
      main: main === null ? null : rel(repoRoot, path.resolve(path.dirname(absolute), main)),
      bindings: declaredBindings(parsed.data, service),
      envKeys: sortedUnique([...Object.keys(parsed.data.vars), ...parsed.data.secrets.required]),
      bindingNames: sortedUnique(collectBindingNames(document)),
      devVarsKeys,
      devVarsFiles,
    });
  }

  manifests.sort((a, b) => a.dir.localeCompare(b.dir) || a.service.localeCompare(b.service));
  return { manifests, unparsedConfigs: unparsedConfigs.sort((a, b) => a.localeCompare(b)) };
}
