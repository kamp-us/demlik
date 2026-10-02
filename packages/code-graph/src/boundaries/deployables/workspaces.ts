import path from "node:path";
import type { ImportEdge } from "../../schema.js";
import { isRelativeName } from "../../syntax/imports.js";
import type { BoundaryViolation } from "../violation.js";

// The nearest workspace root at or above a repo-relative path, or null: the path itself counts, so
// `../../packages/util` reaches the workspace `packages/util`, and so does `../../packages/util/x`.
// A path that leaves the repo is in none.
export function workspaceAt(roots: ReadonlySet<string>, target: string): string | null {
  if (target === ".." || target.startsWith("../")) return null;
  let dir = target;
  while (!roots.has(dir)) {
    if (dir === ".") return null;
    const slash = dir.lastIndexOf("/");
    dir = slash < 0 ? "." : dir.slice(0, slash);
  }
  return dir;
}

type Reach = { readonly specifier: string; readonly typeOnly: boolean };

// B19: a relative import whose target path sits in another workspace than the importer, judged by
// the nearest `package.json` of each. Only the path is read, never the file or a resolution, so an
// import of a path that does not exist is judged too. A file, or a target, in no workspace is
// placed in the scope root. One entry per importer and other workspace, however many files of it
// the importer reaches and however it spells them: the first specifier written, and type-only only
// when every spelling is. `from` is the repo-relative importer, `scope` the scope it is judged in.
export function crossWorkspaceImports(
  roots: ReadonlySet<string>,
  scope: string,
  from: string,
  edges: readonly ImportEdge[],
): BoundaryViolation[] {
  const dir = path.posix.dirname(from);
  const home = workspaceAt(roots, dir) ?? scope;
  const reached = new Map<string, Reach>();
  for (const edge of edges) {
    if (!isRelativeName(edge.specifier)) continue;
    const target = path.posix.join(dir, edge.specifier.replaceAll("\\", "/"));
    const workspace = workspaceAt(roots, target) ?? scope;
    if (workspace === home) continue;
    const held = reached.get(workspace);
    reached.set(workspace, {
      specifier: held?.specifier ?? edge.specifier,
      typeOnly: (held?.typeOnly ?? true) && edge.typeOnly,
    });
  }
  return [...reached].map(
    ([to, reach]): BoundaryViolation => ({
      kind: "relative-import-crosses-workspace",
      from,
      to,
      ...reach,
    }),
  );
}
