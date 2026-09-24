import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Project, type SourceFile } from "ts-morph";

declare module "ts-morph" {
  namespace ts {
    interface SourceFile {
      readonly parseDiagnostics?: readonly unknown[];
    }
  }
}

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

export function listVisibleFiles(
  rootAbsolute: string,
  keep: (relPosix: string) => boolean,
): string[] {
  const candidates = gitVisibleFiles(rootAbsolute) ?? walkedFiles(rootAbsolute);
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

export type LoadedProject = {
  project: Project;
  rootAbsolute: string;
  sourceFiles: SourceFile[];
  parseFailures: string[];
};

export function toRelative(rootAbsolute: string, absolutePath: string): string {
  const rel = path.relative(rootAbsolute, absolutePath);
  return rel.split(path.sep).join("/");
}

export function discoverPackageRoots(rootAbsolute: string): string[] {
  const roots = new Set<string>([""]);
  for (const rel of listVisibleFiles(
    rootAbsolute,
    (f) => path.posix.basename(f) === "package.json",
  )) {
    if (rel.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment))) continue;
    const dir = path.posix.dirname(rel);
    roots.add(dir === "." ? "" : dir);
  }
  return [...roots].sort();
}

export function listSourceFiles(rootAbsolute: string): string[] {
  return listVisibleFiles(rootAbsolute, isSourceFile).map((rel) => path.join(rootAbsolute, rel));
}

function addVisibleSourceFiles(project: Project, rootAbsolute: string): Set<string> {
  const visible = listVisibleFiles(rootAbsolute, isSourceFile);
  for (const rel of visible) project.addSourceFileAtPath(path.join(rootAbsolute, rel));
  return new Set(visible);
}

function hasSyntaxError(sourceFile: SourceFile): boolean {
  const diagnostics = sourceFile.compilerNode.parseDiagnostics;
  return Array.isArray(diagnostics) && diagnostics.length > 0;
}

export function loadCheapProject(rootAbsolute: string): LoadedProject {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: { allowJs: false },
  });

  addVisibleSourceFiles(project, rootAbsolute);
  const added = project.getSourceFiles();

  const clean: SourceFile[] = [];
  const failures: string[] = [];
  for (const sf of added) {
    const rel = toRelative(rootAbsolute, sf.getFilePath());
    let failed = false;
    try {
      failed = hasSyntaxError(sf);
    } catch {
      failed = true;
    }
    if (failed) {
      failures.push(rel);
      project.removeSourceFile(sf);
    } else {
      clean.push(sf);
    }
  }

  clean.sort((a, b) =>
    toRelative(rootAbsolute, a.getFilePath()).localeCompare(
      toRelative(rootAbsolute, b.getFilePath()),
    ),
  );
  failures.sort((a, b) => a.localeCompare(b));

  return { project, rootAbsolute, sourceFiles: clean, parseFailures: failures };
}

export type EdgeScope = "package" | "deep";

export type LoadedEdgeProject = LoadedProject & {
  tsConfigPath: string;
  scope: EdgeScope;
};

function findNearestTsConfig(start: string): string | null {
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

function collectEdgeSourceFiles(
  project: Project,
  rootAbsolute: string,
  visible: ReadonlySet<string>,
): { clean: SourceFile[]; failures: string[] } {
  const clean: SourceFile[] = [];
  const failures: string[] = [];
  for (const sf of project.getSourceFiles()) {
    const rel = toRelative(rootAbsolute, sf.getFilePath());
    if (!visible.has(rel)) continue;
    let failed = false;
    try {
      failed = hasSyntaxError(sf);
    } catch {
      failed = true;
    }
    if (failed) failures.push(rel);
    else clean.push(sf);
  }

  clean.sort((a, b) =>
    toRelative(rootAbsolute, a.getFilePath()).localeCompare(
      toRelative(rootAbsolute, b.getFilePath()),
    ),
  );
  failures.sort((a, b) => a.localeCompare(b));
  return { clean, failures };
}

export function loadEdgeProject(
  rootAbsolute: string,
  scope: EdgeScope,
  repoRoot: string,
): LoadedEdgeProject {
  const tsConfigPath = resolveEdgeTsConfig(rootAbsolute, scope, repoRoot);

  const project = new Project({
    tsConfigFilePath: tsConfigPath,
    skipAddingFilesFromTsConfig: false,
  });

  const visible = addVisibleSourceFiles(project, rootAbsolute);
  const { clean, failures } = collectEdgeSourceFiles(project, rootAbsolute, visible);

  return {
    project,
    rootAbsolute,
    sourceFiles: clean,
    parseFailures: failures,
    tsConfigPath,
    scope,
  };
}

export function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}
