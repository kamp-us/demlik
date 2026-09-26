import {
  listSourceFiles,
  resolveEdgeTsConfig,
} from "@demlik/code-graph/project";
import { Project } from "ts-morph";

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
