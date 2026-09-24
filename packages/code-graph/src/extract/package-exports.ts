import fs from "node:fs";
import path from "node:path";

function stringLeaves(value: unknown, into: string[]): void {
  if (typeof value === "string") {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) stringLeaves(v, into);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) stringLeaves(v, into);
  }
}

function declaredTargets(manifest: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["main", "module", "types", "browser", "bin", "exports"]) {
    stringLeaves(manifest[key], out);
  }
  return out;
}

function toSourcePath(target: string): string {
  const rel = target.replace(/^\.\//, "");
  const fromDist = rel.startsWith("dist/") ? `src/${rel.slice("dist/".length)}` : rel;
  return fromDist.replace(/\.d\.ts$/, ".ts").replace(/\.(js|mjs|cjs)$/, ".ts");
}

function toPattern(sourcePath: string): RegExp | null {
  if (!/\.(ts|tsx)$/.test(sourcePath)) return null;
  const withoutExt = sourcePath.replace(/\.(ts|tsx)$/, "");
  const escaped = withoutExt.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^\\n]*");
  return new RegExp(`^${escaped}\\.(ts|tsx)$`);
}

export function readManifest(repoRoot: string, dir: string): Record<string, unknown> | null {
  let manifest: unknown;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return null;
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest)) record[key] = value;
  return record;
}

export function packageName(manifest: Record<string, unknown>): string | null {
  const name = manifest.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

export function packageSourceEntry(repoRoot: string, dir: string): string | null {
  const manifest = readManifest(repoRoot, dir);
  if (manifest === null) return null;
  const candidates = declaredTargets(manifest)
    .map(toSourcePath)
    .filter((p) => /\.(ts|tsx)$/.test(p) && !p.includes("*"))
    .sort((a, b) => a.localeCompare(b));
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(repoRoot, dir, candidate))) return `${dir}/${candidate}`;
  }
  return null;
}

export function publicExportPatterns(
  repoRoot: string,
  rootAbsolute: string,
  packageDirs: readonly string[],
): RegExp[] {
  const patterns: RegExp[] = [];
  for (const dir of packageDirs) {
    const manifest = readManifest(repoRoot, dir);
    if (manifest === null) continue;
    const packageAbsolute = path.join(repoRoot, dir);
    for (const target of declaredTargets(manifest)) {
      const absolute = path.join(packageAbsolute, toSourcePath(target));
      const relative = path.relative(rootAbsolute, absolute).split(path.sep).join("/");
      if (relative.startsWith("../")) continue;
      const pattern = toPattern(relative);
      if (pattern !== null) patterns.push(pattern);
    }
  }
  return patterns;
}
