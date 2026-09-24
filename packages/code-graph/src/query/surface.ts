import type { ModuleNode } from "../schema.js";

const BARREL_SUFFIXES = ["/index.ts", "/index.tsx"] as const;

function isBarrel(file: string): boolean {
  if (file === "index.ts" || file === "index.tsx") return true;
  return BARREL_SUFFIXES.some((s) => file.endsWith(s));
}

export function publicSurfaceFiles(
  modules: readonly ModuleNode[],
  extraEntryFiles: readonly string[],
  exportPatterns: readonly RegExp[] = [],
): Set<string> {
  const byFile = new Map(modules.map((m) => [m.file, m]));
  const declared = modules
    .filter((m) => exportPatterns.some((p) => p.test(m.file)))
    .map((m) => m.file);
  const queue = [...seedFiles(modules, extraEntryFiles, byFile), ...declared];
  const surface = new Set<string>();

  let i = 0;
  while (i < queue.length) {
    const file = queue[i++];
    if (file === undefined || surface.has(file)) continue;
    surface.add(file);
    queue.push(...reExportTargets(byFile.get(file)));
  }
  return surface;
}

function seedFiles(
  modules: readonly ModuleNode[],
  extraEntryFiles: readonly string[],
  byFile: ReadonlyMap<string, ModuleNode>,
): string[] {
  const seeds = modules.filter((m) => isBarrel(m.file)).map((m) => m.file);
  return [...seeds, ...extraEntryFiles.filter((f) => byFile.has(f))];
}

function reExportTargets(module: ModuleNode | undefined): string[] {
  const out: string[] = [];
  for (const edge of module?.importEdges ?? []) {
    if (edge.kind === "export-from" && edge.target !== null) out.push(edge.target);
  }
  return out;
}
