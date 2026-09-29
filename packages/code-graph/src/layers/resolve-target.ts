import fs from "node:fs";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { z } from "zod";
import { createNearestTsconfigResolver, type NearestTsconfigResolver } from "../engine/oxc.js";
import { packageName, packageSourceEntry, readManifest } from "../extract/package-exports.js";
import { findNearestTsConfig } from "../extract/project.js";

export type WorkspacePackage = {
  readonly name: string;
  readonly dir: string;
  readonly entry: string | null;
};

export type ResolvedTarget =
  | { readonly kind: "file"; readonly file: string }
  /** A workspace package, reached by its declared name. */
  | { readonly kind: "package"; readonly pkg: WorkspacePackage }
  /** An npm dependency, a node builtin, or anything else not resolvable into the repo. */
  | { readonly kind: "external" }
  /** A relative specifier or a tsconfig `paths` alias that names no file on disk — a real gap, counted. */
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

const EXTERNAL: ResolvedTarget = { kind: "external" };

const TsconfigSchema = z.object({
  extends: z.union([z.string(), z.array(z.string())]).optional(),
  compilerOptions: z.object({ paths: z.record(z.string(), z.unknown()).optional() }).optional(),
});

function readTsconfig(file: string): z.infer<typeof TsconfigSchema> | null {
  try {
    const parsed = TsconfigSchema.safeParse(parseJsonc(fs.readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function matchesPathsKey(key: string, specifier: string): boolean {
  const star = key.indexOf("*");
  if (star === -1) return key === specifier;
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  return (
    specifier.length >= prefix.length + suffix.length &&
    specifier.startsWith(prefix) &&
    specifier.endsWith(suffix)
  );
}

type AliasKeys = (fromDir: string) => readonly string[];

function aliasKeysReader(locate: NearestTsconfigResolver["locate"]): AliasKeys {
  const keysByConfig = new Map<string, readonly string[] | null>();

  const keysOf = (configFile: string, visiting: ReadonlySet<string>): readonly string[] | null => {
    const cached = keysByConfig.get(configFile);
    if (cached !== undefined) return cached;
    if (visiting.has(configFile)) return null;
    const config = readTsconfig(configFile);
    const own = config?.compilerOptions?.paths;
    const keys =
      own === undefined
        ? inheritedKeys(configFile, config?.extends, new Set([...visiting, configFile]))
        : Object.keys(own);
    keysByConfig.set(configFile, keys);
    return keys;
  };

  const inheritedKeys = (
    configFile: string,
    extendsField: string | readonly string[] | undefined,
    visiting: ReadonlySet<string>,
  ): readonly string[] | null => {
    for (const parent of [extendsField ?? []].flat().reverse()) {
      const located = locate(path.dirname(configFile), parent);
      const keys = located === null ? null : keysOf(located, visiting);
      if (keys !== null) return keys;
    }
    return null;
  };

  return (fromDir) => {
    const config = findNearestTsConfig(fromDir);
    return config === null ? [] : (keysOf(config, new Set()) ?? []);
  };
}

function inRepoFile(realRoot: string, resolved: string): ResolvedTarget {
  const relative = path.relative(realRoot, resolved);
  const segments = relative.split(path.sep);
  if (segments[0] === ".." || path.isAbsolute(relative) || segments.includes("node_modules")) {
    return EXTERNAL;
  }
  return { kind: "file", file: segments.join("/") };
}

export type TargetResolver = (fromFile: string, specifier: string) => ResolvedTarget;

export function createTargetResolver(
  repoRoot: string,
  packages: ReadonlyMap<string, WorkspacePackage>,
): TargetResolver {
  const nearest = createNearestTsconfigResolver();
  const aliasKeys = aliasKeysReader(nearest.locate);
  const realRoot = fs.realpathSync(repoRoot);

  const resolveBare = (fromFile: string, specifier: string): ResolvedTarget => {
    const absolute = path.join(repoRoot, fromFile);
    const outcome = nearest.resolve(absolute, specifier);
    switch (outcome.kind) {
      case "path":
        return inRepoFile(realRoot, outcome.path);
      case "builtin":
        return EXTERNAL;
      case "missing":
        return aliasKeys(path.dirname(absolute)).some((key) => matchesPathsKey(key, specifier))
          ? { kind: "unresolved", specifier }
          : EXTERNAL;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  };

  return (fromFile, specifier) => {
    if (specifier.startsWith(".")) return resolveRelative(repoRoot, fromFile, specifier);
    const pkg = matchPackage(specifier, packages);
    return pkg === undefined ? resolveBare(fromFile, specifier) : { kind: "package", pkg };
  };
}
