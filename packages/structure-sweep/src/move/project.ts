import { join, relative } from "node:path";
import {
  listSourceFiles,
  resolveEdgeTsConfig,
} from "@demlik/code-graph/project";
import { Project } from "ts-morph";
import type { ImportEdge } from "./plan.js";

/**
 * The ts-morph program the mover rewrites imports in: the scope's tsconfig plus every source file
 * git can see under the scope. It moved here from code-graph (#397), which reads TypeScript with
 * oxc and tsgo and no longer carries ts-morph; rewriting imports in place is ts-morph's job.
 */
export function loadMoveProject(scopeRoot: string, repoRoot: string): Project {
  const project = new Project({
    tsConfigFilePath: resolveEdgeTsConfig(scopeRoot, "package", repoRoot),
    skipAddingFilesFromTsConfig: false,
  });
  for (const file of listSourceFiles(scopeRoot))
    project.addSourceFileAtPath(file);
  return project;
}

/**
 * Every relative import or re-export in the move project that resolves to another of `tracked`,
 * from a file that is itself in `tracked` — the scope's module graph, repo-relative and sorted.
 */
export function importEdges(
  repoRoot: string,
  scope: string,
  tracked: readonly string[],
): ImportEdge[] {
  const project = loadMoveProject(join(repoRoot, scope), repoRoot);
  const inTree = new Set(tracked);
  const edges = new Map<string, ImportEdge>();
  for (const sourceFile of project.getSourceFiles()) {
    const from = relative(repoRoot, sourceFile.getFilePath());
    if (!inTree.has(from)) continue;
    for (const declaration of [
      ...sourceFile.getImportDeclarations(),
      ...sourceFile.getExportDeclarations(),
    ]) {
      if (!declaration.getModuleSpecifierValue()?.startsWith(".")) continue;
      const target = declaration.getModuleSpecifierSourceFile();
      if (target === undefined) continue;
      const to = relative(repoRoot, target.getFilePath());
      if (to === from || !inTree.has(to)) continue;
      edges.set(JSON.stringify([from, to]), { from, to });
    }
  }
  return [...edges.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
}
