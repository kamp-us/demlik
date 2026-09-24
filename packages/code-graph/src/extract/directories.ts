import path from "node:path";
import type { DirectoryNode, ModuleNode, Thresholds } from "../schema.js";
import { smellsForDirectory } from "../smells/evaluate.js";

function dirOf(file: string): string {
  const d = path.posix.dirname(file);
  return d === "" ? "." : d;
}

export function buildDirectories(modules: ModuleNode[], thresholds: Thresholds): DirectoryNode[] {
  const byDir = new Map<string, { files: string[]; functionCount: number }>();
  for (const m of modules) {
    const dir = dirOf(m.file);
    const entry = byDir.get(dir) ?? { files: [], functionCount: 0 };
    entry.files.push(m.file);
    entry.functionCount += m.functionIds.length;
    byDir.set(dir, entry);
  }

  const directories: DirectoryNode[] = [];
  for (const [dir, entry] of byDir) {
    const files = entry.files.slice().sort((a, b) => a.localeCompare(b));
    const node: DirectoryNode = {
      dir,
      fileCount: files.length,
      functionCount: entry.functionCount,
      files,
      smells: [],
    };
    node.smells = smellsForDirectory(node, thresholds);
    directories.push(node);
  }
  directories.sort((a, b) => a.dir.localeCompare(b.dir));
  return directories;
}
