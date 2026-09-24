import fs from "node:fs";
import path from "node:path";
import { packageName, packageSourceEntry, readManifest } from "../extract/package-exports.js";

export type WorkspacePackage = {
  readonly name: string;
  readonly dir: string;
  readonly entry: string | null;
};

export type ResolvedTarget =
  | { readonly kind: "file"; readonly file: string }
  /** A workspace package, reached by its declared name. */
  | { readonly kind: "package"; readonly pkg: WorkspacePackage }
  /** An npm dependency or a node builtin — outside the repo, outside the lattice. */
  | { readonly kind: "external" }
  /** A relative specifier that names no file on disk — a real gap, counted. */
  | { readonly kind: "unresolved"; readonly specifier: string };

export function workspacePackages(
  repoRoot: string,
  packageDirs: readonly string[],
): Map<string, WorkspacePackage> {
  const byName = new Map<string, WorkspacePackage>();
  for (const dir of packageDirs) {
    if (dir === "") continue;
    const manifest = readManifest(repoRoot, dir);
    if (manifest === null) continue;
    const name = packageName(manifest);
    if (name === null || byName.has(name)) continue;
    byName.set(name, { name, dir, entry: packageSourceEntry(repoRoot, dir) });
  }
  return byName;
}

const PROBES = [".ts", ".tsx", ".d.ts", "/index.ts", "/index.tsx", ""] as const;

function resolveRelative(repoRoot: string, fromFile: string, specifier: string): ResolvedTarget {
  const base = path
    .join(path.dirname(path.join(repoRoot, fromFile)), specifier)
    .replace(/\.(js|jsx|mjs|cjs)$/, "");
  for (const probe of PROBES) {
    const candidate = `${base}${probe}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { kind: "file", file: path.relative(repoRoot, candidate).split(path.sep).join("/") };
    }
  }
  return { kind: "unresolved", specifier };
}

function matchPackage(
  specifier: string,
  packages: ReadonlyMap<string, WorkspacePackage>,
): WorkspacePackage | undefined {
  const direct = packages.get(specifier);
  if (direct !== undefined) return direct;
  const scoped = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : undefined;
  const bare = specifier.split("/")[0];
  if (scoped !== undefined) return packages.get(scoped);
  return bare === undefined ? undefined : packages.get(bare);
}

export function resolveTarget(
  repoRoot: string,
  fromFile: string,
  specifier: string,
  packages: ReadonlyMap<string, WorkspacePackage>,
): ResolvedTarget {
  if (specifier.startsWith(".")) return resolveRelative(repoRoot, fromFile, specifier);
  const pkg = matchPackage(specifier, packages);
  return pkg === undefined ? { kind: "external" } : { kind: "package", pkg };
}
