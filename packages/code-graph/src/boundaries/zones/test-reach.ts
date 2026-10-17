import type { ImportEdge } from "../../schema.js";
import { inScope } from "../rules.js";
import type { BoundaryViolation } from "../violation.js";
import { matchesGlobs } from "./test-role.js";

// A file of a scope as B20 reads it: its import edges, and the specifiers it opens when it runs,
// which `import type` and `import { type X }` are not.
export type OpeningFile = {
  readonly file: string;
  readonly importEdges: readonly ImportEdge[];
  readonly runtimeSpecifiers: ReadonlySet<string>;
};

// The files of the scope that a file opens when it runs, each once with the first specifier that
// names it. An import that resolves to no file the scope loads opens none.
function opened(file: OpeningFile): ReadonlyMap<string, string> {
  const targets = new Map<string, string>();
  for (const edge of file.importEdges) {
    if (edge.target === null || !file.runtimeSpecifiers.has(edge.specifier)) continue;
    if (!targets.has(edge.target)) targets.set(edge.target, edge.specifier);
  }
  return targets;
}

// The composition roots of a scope, and every file that opens one when it runs, directly or through
// other files: the reach. All paths are scope-relative, and a root is in its own reach.
export type RootReach = {
  readonly roots: ReadonlySet<string>;
  readonly inReach: ReadonlySet<string>;
};

const NO_ROOTS: RootReach = { roots: new Set(), inReach: new Set() };

// Walks back from the roots over what the files open, so a cycle ends where it started.
export function rootReachOf(
  globs: readonly RegExp[],
  scope: string,
  files: readonly OpeningFile[],
): RootReach {
  if (globs.length === 0) return NO_ROOTS;
  const roots = new Set(
    files.filter(({ file }) => matchesGlobs(globs, scope, file)).map(({ file }) => file),
  );
  const openedBy = new Map<string, string[]>();
  for (const file of files) {
    for (const target of opened(file).keys()) {
      const openers = openedBy.get(target);
      if (openers === undefined) openedBy.set(target, [file.file]);
      else openers.push(file.file);
    }
  }
  const inReach = new Set(roots);
  const pending = [...roots];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const opener of openedBy.get(next) ?? []) {
      if (inReach.has(opener)) continue;
      inReach.add(opener);
      pending.push(opener);
    }
  }
  return { roots, inReach };
}

// B20 for one test file: one entry per file it opens that is in reach, the first file on its way to
// a root, `to` the root itself when it opens one directly. A root is never reported as a test.
export function testReachViolations(
  reach: RootReach,
  scope: string,
  test: OpeningFile,
): BoundaryViolation[] {
  if (reach.roots.has(test.file)) return [];
  return [...opened(test)]
    .filter(([target]) => reach.inReach.has(target))
    .map(
      ([target, specifier]): BoundaryViolation => ({
        kind: "test-reaches-composition-root",
        from: inScope(scope, test.file),
        to: inScope(scope, target),
        specifier,
        typeOnly: false,
      }),
    );
}
