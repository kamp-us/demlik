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

const PRUNED_DIRECTORIES = new Set([
  "node_modules",
  "vendor",
  "dist",
  ".next",
  ".git",
  "__generated__",
]);

function isSourceFileName(name: string): boolean {
  return /\.tsx?$/.test(name) && !name.endsWith(".d.ts") && !name.endsWith(".gen.ts");
}

export function listSourceFiles(rootAbsolute: string): string[] {
  const files: string[] = [];
  const walk = (absDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(absDir, e.name);
      if (e.isDirectory()) {
        if (!PRUNED_DIRECTORIES.has(e.name)) walk(abs);
      } else if (e.isFile() && isSourceFileName(e.name)) {
        files.push(abs);
      }
    }
  };
  walk(rootAbsolute);
  return files;
}

export function discoverPackageRoots(rootAbsolute: string): string[] {
  const roots = new Set<string>([""]);
  const walk = (absDir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "package.json")) roots.add(rel);
    for (const e of entries) {
      if (!e.isDirectory() || PRUNED_DIRECTORIES.has(e.name)) continue;
      walk(path.join(absDir, e.name), rel === "" ? e.name : `${rel}/${e.name}`);
    }
  };
  walk(rootAbsolute, "");
  return [...roots].sort();
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

  const added = listSourceFiles(rootAbsolute).map((file) => project.addSourceFileAtPath(file));

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

function isExcludedEdgeFile(rel: string): boolean {
  return (
    rel.includes("node_modules/") ||
    rel.includes("/dist/") ||
    rel.startsWith("dist/") ||
    rel.includes("/.next/") ||
    rel.includes("__generated__/") ||
    /\.gen\.ts$/.test(rel)
  );
}

function isEnumerableEdgeFile(sf: SourceFile, rootAbsolute: string, rootPosix: string): boolean {
  const abs = sf.getFilePath();
  if (!abs.split(path.sep).join("/").startsWith(rootPosix)) return false;
  if (/\.d\.ts$/.test(abs)) return false;
  return !isExcludedEdgeFile(toRelative(rootAbsolute, abs));
}

function collectEdgeSourceFiles(
  project: Project,
  rootAbsolute: string,
): { clean: SourceFile[]; failures: string[] } {
  const rootPosix = `${rootAbsolute.split(path.sep).join("/")}/`;
  const clean: SourceFile[] = [];
  const failures: string[] = [];
  for (const sf of project.getSourceFiles()) {
    if (!isEnumerableEdgeFile(sf, rootAbsolute, rootPosix)) continue;
    const rel = toRelative(rootAbsolute, sf.getFilePath());
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

  for (const file of listSourceFiles(rootAbsolute)) project.addSourceFileAtPath(file);

  const { clean, failures } = collectEdgeSourceFiles(project, rootAbsolute);

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
