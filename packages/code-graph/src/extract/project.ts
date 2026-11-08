import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { globSync } from "tinyglobby";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseTypeScript } from "../engine/oxc.js";
import { SyntaxFile } from "../syntax/file.js";

const WALK_PRUNE = new Set([
  ".claude",
  ".git",
  ".next",
  ".turbo",
  ".wrangler",
  "__generated__",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

function gitVisibleFiles(rootAbsolute: string): string[] | null {
  let out: string;
  try {
    out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: rootAbsolute,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  return out.split("\0").filter((rel) => rel !== "" && !rel.endsWith("/"));
}

function walkedFiles(rootAbsolute: string): string[] {
  const found: string[] = [];
  const walk = (absDir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (!WALK_PRUNE.has(e.name)) walk(path.join(absDir, e.name), childRel);
      } else if (e.isFile()) {
        found.push(childRel);
      }
    }
  };
  walk(rootAbsolute, "");
  return found;
}

function isRegularFile(absolute: string): boolean {
  try {
    return fs.statSync(absolute).isFile();
  } catch {
    return false;
  }
}

// A repo's visible files, listed once. A pass that reads many scopes under one repo root hands this
// to each read instead of every read listing its own scope: that is one listing process per scope,
// and a repo of libraries has dozens.
export type RepoListing = { readonly root: string; readonly files: readonly string[] };

export function listRepo(root: string): RepoListing {
  return { root, files: gitVisibleFiles(root) ?? walkedFiles(root) };
}

// The listed files below `rootAbsolute`, as paths relative to it.
function listedUnder(listing: RepoListing, rootAbsolute: string): string[] {
  const prefix = toRelative(listing.root, rootAbsolute);
  if (prefix === "") return [...listing.files];
  const below = `${prefix}/`;
  return listing.files.filter((rel) => rel.startsWith(below)).map((rel) => rel.slice(below.length));
}

export function listVisibleFiles(
  rootAbsolute: string,
  keep: (relPosix: string) => boolean,
  listing?: RepoListing,
): string[] {
  const candidates =
    listing === undefined
      ? (gitVisibleFiles(rootAbsolute) ?? walkedFiles(rootAbsolute))
      : listedUnder(listing, rootAbsolute);
  return candidates
    .filter((rel) => keep(rel) && isRegularFile(path.join(rootAbsolute, rel)))
    .sort((a, b) => a.localeCompare(b));
}

const EXCLUDED_SEGMENTS = new Set(["node_modules", "vendor", "dist", ".next", "__generated__"]);

function isSourceFile(rel: string): boolean {
  if (!/\.tsx?$/.test(rel) || /\.d\.ts$/.test(rel) || /\.gen\.ts$/.test(rel)) return false;
  return !rel
    .split("/")
    .some((segment) => segment.startsWith(".") || EXCLUDED_SEGMENTS.has(segment));
}

export type SourceUnit = {
  readonly absolutePath: string;
  readonly file: string;
  readonly syntax: SyntaxFile;
};

export type LoadedProject = {
  readonly rootAbsolute: string;
  readonly sourceFiles: readonly SourceUnit[];
  readonly parseFailures: readonly string[];
};

export function toRelative(rootAbsolute: string, absolutePath: string): string {
  const rel = path.relative(rootAbsolute, absolutePath);
  return rel.split(path.sep).join("/");
}

const WorkspacePatternsSchema = z.array(z.string());
const PnpmWorkspaceSchema = z
  .object({ packages: z.array(z.string().min(1)).default([]) })
  .nullish();
const NpmWorkspaceSchema = z.object({
  workspaces: z.union([WorkspacePatternsSchema, z.object({ packages: WorkspacePatternsSchema })]),
});

function workspacePatterns(repoRoot: string): string[] | null {
  const yamlFile = path.join(repoRoot, "pnpm-workspace.yaml");
  const file = fs.existsSync(yamlFile) ? yamlFile : path.join(repoRoot, "package.json");
  if (file !== yamlFile && !declaresWorkspaces(repoRoot)) return null;
  try {
    const text = readSource(file);
    if (file === yamlFile) return PnpmWorkspaceSchema.parse(parseYaml(text))?.packages ?? [];
    const { workspaces } = NpmWorkspaceSchema.parse(JSON.parse(text));
    return Array.isArray(workspaces) ? workspaces : workspaces.packages;
  } catch (cause) {
    throw new Error(`code-graph: invalid workspace manifest ${file}`, { cause });
  }
}

export function discoverPackageRoots(rootAbsolute: string, listing?: RepoListing): string[] {
  const repoRoot = findRepoRoot(rootAbsolute);
  const patterns = workspacePatterns(repoRoot);
  const members = new Set(
    globSync(
      patterns?.map((pattern) => pattern.replace(/\/?$/, "/package.{json,yaml,json5}")) ?? [],
      {
        cwd: repoRoot,
        expandDirectories: false,
        ignore: ["**/node_modules/**", "**/bower_components/**"],
      },
    ).map((manifest) => toRelative(repoRoot, path.dirname(path.join(repoRoot, manifest)))),
  );
  const roots = new Set<string>([""]);
  for (const rel of listVisibleFiles(
    rootAbsolute,
    (f) => path.posix.basename(f) === "package.json",
    listing,
  )) {
    if (rel.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment))) continue;
    const dir = path.posix.dirname(rel);
    if (patterns && !members.has(toRelative(repoRoot, path.join(rootAbsolute, dir)))) continue;
    roots.add(dir === "." ? "" : dir);
  }
  return [...roots].sort();
}

export function listSourceFiles(rootAbsolute: string): string[] {
  return listVisibleFiles(rootAbsolute, isSourceFile).map((rel) => path.join(rootAbsolute, rel));
}

function readSource(absolutePath: string): string {
  const text = fs.readFileSync(absolutePath, "utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseUnit(rootAbsolute: string, rel: string): SourceUnit | null {
  const absolutePath = path.join(rootAbsolute, rel);
  let text: string;
  try {
    text = readSource(absolutePath);
  } catch {
    return null;
  }
  const parsed = parseTypeScript(absolutePath, text);
  if (!parsed.ok) return null;
  return {
    absolutePath,
    file: rel,
    syntax: new SyntaxFile(text, parsed.program, parsed.comments),
  };
}

export function loadCheapProject(rootAbsolute: string, listing?: RepoListing): LoadedProject {
  const sourceFiles: SourceUnit[] = [];
  const parseFailures: string[] = [];
  for (const rel of listVisibleFiles(rootAbsolute, isSourceFile, listing)) {
    const unit = parseUnit(rootAbsolute, rel);
    if (unit === null) parseFailures.push(rel);
    else sourceFiles.push(unit);
  }
  parseFailures.sort((a, b) => a.localeCompare(b));
  return { rootAbsolute, sourceFiles, parseFailures };
}

export type EdgeScope = "package" | "deep";

export type LoadedEdgeProject = LoadedProject & {
  readonly tsConfigPath: string;
  readonly scope: EdgeScope;
};

export function findNearestTsConfig(start: string): string | null {
  let dir = start;
  for (;;) {
    const candidate = path.join(dir, "tsconfig.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveEdgeTsConfig(
  rootAbsolute: string,
  scope: EdgeScope,
  repoRoot: string,
): string {
  const start = scope === "deep" ? repoRoot : rootAbsolute;
  const found = findNearestTsConfig(start);
  if (!found) {
    throw new Error(
      `code-graph: no tsconfig.json found ${scope === "deep" ? `at or above the repo root (${repoRoot})` : `at or above ${rootAbsolute}`}; the edge pass needs one to resolve modules (SPEC §3).`,
    );
  }
  return found;
}

export function loadEdgeProject(
  rootAbsolute: string,
  scope: EdgeScope,
  repoRoot: string,
  listing?: RepoListing,
): LoadedEdgeProject {
  const tsConfigPath = resolveEdgeTsConfig(rootAbsolute, scope, repoRoot);
  return { ...loadCheapProject(rootAbsolute, listing), tsConfigPath, scope };
}

// A folder's `package.json` declares workspaces. A manifest that cannot be read or parsed declares
// nothing, so a broken file costs that folder its claim and never the walk.
function declaresWorkspaces(dir: string): boolean {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readSource(path.join(dir, "package.json")));
  } catch {
    return false;
  }
  return typeof manifest === "object" && manifest !== null && "workspaces" in manifest;
}

// What makes a folder a repo root, strongest first. Each is searched over the whole walk before the
// next is tried, so a `pnpm-workspace.yaml` far above outranks a `workspaces` key close by. `.git`
// exists as a directory in a clone and as a file in a linked worktree.
const REPO_ROOT_MARKS: readonly ((dir: string) => boolean)[] = [
  (dir) => fs.existsSync(path.join(dir, "pnpm-workspace.yaml")),
  declaresWorkspaces,
  (dir) => fs.existsSync(path.join(dir, ".git")),
];

function nearestAncestor(start: string, marked: (dir: string) => boolean): string | null {
  let dir = start;
  for (;;) {
    if (marked(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function findRepoRoot(start: string): string {
  for (const marked of REPO_ROOT_MARKS) {
    const root = nearestAncestor(start, marked);
    if (root !== null) return root;
  }
  return start;
}
