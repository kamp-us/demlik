import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { globSync } from "tinyglobby";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { PathMove } from "./manifest.js";

/**
 * A `package.json` `exports` value as Node reads it: a target path, a blocked target (`null`), a
 * fallback list, or an object keyed by subpath (`"./x"`) or condition (`"import"`).
 */
export type Exports =
  | string
  | null
  | readonly Exports[]
  | { readonly [key: string]: Exports };

const Exports: z.ZodType<Exports> = z.lazy(() =>
  z.union([
    z.string(),
    z.null(),
    z.array(Exports),
    z.record(z.string(), Exports),
  ]),
);

const PackageJson = z.object({
  name: z.string().min(1).optional(),
  exports: Exports.optional(),
});

/**
 * One workspace package. `root` is repo-relative, `.` for the repository root. `name` and `exports`
 * are its `package.json`'s, `undefined` where that file does not declare them — or, for the root
 * alone, where there is no root `package.json` at all.
 */
export type WorkspacePackage = {
  readonly root: string;
  readonly name: string | undefined;
  readonly exports: Exports | undefined;
};

/**
 * A repository's pnpm workspace: the package at the repository root, which holds every path no
 * member holds, and the members its globs match, ordered by root. A repository with no
 * `pnpm-workspace.yaml` is the root package alone.
 */
export type Workspace = {
  readonly root: WorkspacePackage;
  readonly members: readonly WorkspacePackage[];
};

const PnpmWorkspace = z
  .object({ packages: z.array(z.string()).optional() })
  .nullable();

/** The directories pnpm's package search never descends into (`@pnpm/fs.find-packages`). */
const IGNORED = ["node_modules", "bower_components", "test", "tests"].map(
  (dir) => `**/${dir}/**`,
);

/** A `packages` glob as the `package.json` paths it selects, its `!` kept, as pnpm rewrites it. */
function manifestPattern(glob: string): string {
  const negated = glob.startsWith("!");
  const path = posix.normalize(negated ? glob.slice(1) : glob);
  return `${negated ? "!" : ""}${posix.join(path, "package.json")}`;
}

/**
 * The directory of every `package.json` the `packages` globs select, repo-relative, read by the
 * library pnpm's own package search reads them with, so every glob means here what it means to pnpm.
 */
function memberDirs(repoRoot: string, globs: readonly string[]): string[] {
  if (globs.length === 0) return [];
  return globSync(globs.map(manifestPattern), {
    cwd: repoRoot,
    ignore: IGNORED,
    expandDirectories: false,
  })
    .map((manifest) => posix.dirname(manifest))
    .filter((dir) => dir !== ".")
    .sort();
}

function readPackage(repoRoot: string, root: string): WorkspacePackage {
  const path = join(repoRoot, root, "package.json");
  if (!existsSync(path)) return { root, name: undefined, exports: undefined };
  const parsed = PackageJson.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success)
    throw new Error(
      `${posix.join(root, "package.json")}: unreadable name or exports: ${parsed.error.message}`,
    );
  return { root, name: parsed.data.name, exports: parsed.data.exports };
}

/**
 * The workspace read off `pnpm-workspace.yaml` at `repoRoot`: the root package, then every directory
 * holding a `package.json` that one of its `packages` globs matches and no `!` glob excludes.
 */
export function readWorkspace(repoRoot: string): Workspace {
  const root = readPackage(repoRoot, ".");
  const file = join(repoRoot, "pnpm-workspace.yaml");
  if (!existsSync(file)) return { root, members: [] };
  const parsed = PnpmWorkspace.safeParse(parseYaml(readFileSync(file, "utf8")));
  if (!parsed.success)
    throw new Error(
      `pnpm-workspace.yaml: unreadable packages list: ${parsed.error.message}`,
    );
  const members = memberDirs(repoRoot, parsed.data?.packages ?? []);
  return { root, members: members.map((dir) => readPackage(repoRoot, dir)) };
}

/** The package a repo-relative path sits in: the member whose root is its nearest ancestor, else the root. */
export function packageOf(
  workspace: Workspace,
  path: string,
): WorkspacePackage {
  let best: WorkspacePackage | undefined;
  for (const pkg of workspace.members) {
    if (
      path.startsWith(`${pkg.root}/`) &&
      (best === undefined || pkg.root.length > best.root.length)
    )
      best = pkg;
  }
  return best ?? workspace.root;
}

/** How a package is named to a person: its `name`, or where it is when it has none. */
export const packageLabel = (pkg: WorkspacePackage): string =>
  pkg.name ?? `the unnamed package at ${pkg.root}`;

/** A manifest row with the package it leaves and the package it lands in. */
export type PlacedRow = {
  readonly row: PathMove;
  readonly from: WorkspacePackage;
  readonly to: WorkspacePackage;
};

export const placeRow = (workspace: Workspace, row: PathMove): PlacedRow => ({
  row,
  from: packageOf(workspace, row.from),
  to: packageOf(workspace, row.to),
});

/** Whether a row leaves one package for another. */
export const crossesPackages = ({ from, to }: PlacedRow): boolean =>
  from.root !== to.root;
