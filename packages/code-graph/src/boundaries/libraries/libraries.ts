import fs from "node:fs";
import path from "node:path";
import { discoverPackageRoots, listRepo, type RepoListing } from "../../extract/project.js";
import { globToRegExp } from "../../kinds/glob.js";
import {
  matchPackage,
  type WorkspacePackage,
  workspacePackages,
} from "../../layers/resolve-target.js";
import {
  declaresLibraries,
  type ImportedFrom,
  type LibraryRules,
  type LibraryType,
} from "./schema.js";

// The libraries a repo declares, read once: the rules file's four keys beside what the repo says
// about itself (which directories are packages, and what each is named). Every question the
// judgments ask about a library, a package or a specifier is answered here and nowhere else.
export type Libraries = {
  readonly declared: boolean;
  readonly rules: LibraryRules;
  // The declared libraries' directories, longest first, so the first one a file sits under is the
  // nearest.
  readonly dirs: readonly string[];
  readonly typeOfDir: ReadonlyMap<string, string>;
  readonly packages: ReadonlyMap<string, WorkspacePackage>;
  // Every package root below the repo root, which is what a library root is checked against.
  readonly packageDirs: readonly string[];
  readonly world: readonly RegExp[];
};

const NO_RULES: LibraryRules = {
  libraryTypes: {},
  libraries: {},
  libraryRoots: [],
  worldLibraries: [],
};

// What a rules file that declares no library key reads as: no library, no root and no world
// library, so every question below answers "none" without the repo being read.
export const NO_LIBRARIES: Libraries = {
  declared: false,
  rules: NO_RULES,
  dirs: [],
  typeOfDir: new Map(),
  packages: new Map(),
  packageDirs: [],
  world: [],
};

export type LibrariesRead =
  | { readonly kind: "read"; readonly libraries: Libraries }
  | { readonly kind: "refused"; readonly message: string };

function isDirectory(repoRoot: string, rel: string): boolean {
  try {
    return fs.statSync(path.join(repoRoot, rel)).isDirectory();
  } catch {
    return false;
  }
}

// A root is written as a clean repo-relative path (`packages`, never `packages/` or `./packages`),
// because a file's directory is matched against it as written.
function rootIssues(root: string, repoRoot: string): string[] {
  const clean =
    path.posix.normalize(root) === root && !root.startsWith("..") && !root.endsWith("/");
  if (clean && isDirectory(repoRoot, root)) return [];
  return [
    `libraryRoots entry "${root}" is no directory of the repo: write a repo-relative path such as packages.`,
  ];
}

function libraryIssues(dir: string, packageDirs: ReadonlySet<string>): string[] {
  if (packageDirs.has(dir)) return [];
  return [
    `library "${dir}" is no package root: a library is a directory below the repo root that holds a package.json.`,
  ];
}

// Reads the repo for the declared libraries, or says in one line why the declaration cannot stand.
// A declaration that names no library key costs nothing: the repo is not read. `listing` is the
// repo's files, listed once for the run.
export function readLibraries(
  rules: LibraryRules,
  repoRoot: string,
  listing: RepoListing | undefined,
): LibrariesRead {
  if (!declaresLibraries(rules)) return { kind: "read", libraries: NO_LIBRARIES };
  const files = listing ?? listRepo(repoRoot);
  const packageDirs = discoverPackageRoots(repoRoot, files).filter((dir) => dir !== "");
  const known = new Set(packageDirs);
  const [message] = [
    ...rules.libraryRoots.flatMap((root) => rootIssues(root, repoRoot)),
    ...Object.keys(rules.libraries).flatMap((dir) => libraryIssues(dir, known)),
  ];
  if (message !== undefined) return { kind: "refused", message };
  return {
    kind: "read",
    libraries: {
      declared: true,
      rules,
      dirs: Object.keys(rules.libraries).sort((a, b) => b.length - a.length),
      typeOfDir: new Map(Object.entries(rules.libraries)),
      packages: workspacePackages(repoRoot, packageDirs),
      packageDirs,
      world: rules.worldLibraries.map(globToRegExp),
    },
  };
}

// Every scope the library keys add to the pass: a scope per declared library, and one per root,
// which holds the packages no library names.
export function libraryScopes(libraries: Libraries): string[] {
  return [...libraries.dirs, ...libraries.rules.libraryRoots];
}

// The type a declared library is, or null for a directory that is not one.
export function libraryTypeOf(libraries: Libraries, dir: string): LibraryType | null {
  const name = libraries.typeOfDir.get(dir);
  return name === undefined ? null : (libraries.rules.libraryTypes[name] ?? null);
}

// The declared library a repo-relative file sits in, the nearest when libraries nest.
export function ownerOf(libraries: Libraries, file: string): string | null {
  return libraries.dirs.find((dir) => file.startsWith(`${dir}/`)) ?? null;
}

// What an import specifier names. A bare specifier resolves to a workspace package by name, a
// subpath included (`@shop/pkg/sub` is `@shop/pkg`), and never through the package's `exports`.
export type ImportTarget =
  | { readonly kind: "library"; readonly dir: string; readonly type: string }
  | { readonly kind: "undeclared"; readonly dir: string }
  | { readonly kind: "outside" };

const OUTSIDE: ImportTarget = { kind: "outside" };

export function importTargetOf(libraries: Libraries, specifier: string): ImportTarget {
  const pkg = matchPackage(specifier, libraries.packages);
  if (pkg === undefined) return OUTSIDE;
  const type = libraries.typeOfDir.get(pkg.dir);
  return type === undefined
    ? { kind: "undeclared", dir: pkg.dir }
    : { kind: "library", dir: pkg.dir, type };
}

// Whether a specifier names a package one of the globs matches: a glob matches the specifier's name
// and any subpath of it, so `@sentry/*` matches `@sentry/node` and `@sentry/node/integrations`,
// never `@sentryx/node`. A relative specifier names a file, not a package. The one matcher for
// `worldLibraries` (B13) and `pureDependencies` (B16).
export function inPackageGlobs(globs: readonly RegExp[], specifier: string): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return false;
  const segments = specifier.split("/");
  return segments.some((_, index) => {
    const head = segments.slice(0, index + 1).join("/");
    return globs.some((entry) => entry.test(head));
  });
}

// A world library is named by package: see `inPackageGlobs`.
export function isWorldLibrary(libraries: Libraries, specifier: string): boolean {
  return inPackageGlobs(libraries.world, specifier);
}

// Whether a file in `zone` may not import the declared library `dir`: its type names where it may
// be imported from, and `zone` is not one of them (B14). A `null` zone is a place no `importedFrom`
// names: a hexagonal feature's `application/`, `adapters/driving/`, `index.ts` and `ports.ts`.
export function importedFromOutside(
  libraries: Libraries,
  dir: string,
  zone: ImportedFrom | null,
): boolean {
  const zones = libraryTypeOf(libraries, dir)?.importedFrom;
  if (zones === undefined || zones.includes("any")) return false;
  return zone === null || !zones.includes(zone);
}

function depthOf(root: string): number {
  return root === "." ? 0 : root.split("/").length;
}

function isBelow(dir: string, root: string): boolean {
  return root === "." || dir.startsWith(`${root}/`);
}

// The nearest declared root a package sits below, or null.
function rootOf(libraries: Libraries, dir: string): string | null {
  const roots = libraries.rules.libraryRoots.filter((root) => isBelow(dir, root));
  return roots.reduce<string | null>(
    (nearest, root) => (nearest === null || depthOf(root) > depthOf(nearest) ? root : nearest),
    null,
  );
}

// The packages at any depth below `root` that no library names, whose nearest root it is.
export function undeclaredUnder(libraries: Libraries, root: string): string[] {
  return libraries.packageDirs
    .filter((dir) => !libraries.typeOfDir.has(dir) && rootOf(libraries, dir) === root)
    .sort((a, b) => a.localeCompare(b));
}
