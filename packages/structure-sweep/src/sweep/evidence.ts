import { createHash } from "node:crypto";
import { basename, dirname, extname, join, normalize } from "node:path";
import { git, trackedPaths } from "../git.js";
import type { GraphFacts } from "./graph.js";

export const SOURCE_LIMIT = 7000;

export type FileEvidence = {
  readonly file: {
    readonly path: string;
    readonly exports: readonly string[];
    readonly imports: readonly string[];
    readonly importedBySiblings: readonly string[];
    readonly source: string;
    readonly graph?: GraphFacts;
  };
};

export interface SourceFile {
  readonly path: string;
  readonly text: string;
  readonly hash: string;
}

const IS_SOURCE = /\.(ts|tsx)$/;
const IS_EXCLUDED =
  /(\.test\.|\.spec\.|\.stories\.|\.d\.ts$|__generated__|\/test\/|\/__tests__\/)/;

/** Whether `sweep` asks about the file at `path`: TypeScript source, not a test, story or declaration. */
export const isSweptSource = (path: string) =>
  IS_SOURCE.test(path) && !IS_EXCLUDED.test(path);

export const contentHash = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Every non-test TypeScript source under `scope` as `ref` has it — the tree, not the working copy. */
export function listSources(
  cwd: string,
  ref: string,
  scope: string,
): SourceFile[] {
  return trackedPaths(cwd, { ref }, scope)
    .filter(isSweptSource)
    .map((path) => {
      const text = git(cwd, ["show", `${ref}:${path}`]);
      return { path, text, hash: contentHash(text) };
    });
}

const IMPORT = /^\s*import[\s\S]*?from\s+["']([^"']+)["'];?\s*$/gm;
const EXPORT =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;

function importsOf(text: string): string[] {
  return [...text.matchAll(IMPORT)].map((m) => m[1] ?? "").filter(Boolean);
}

function withoutExt(path: string): string {
  return path.slice(0, path.length - extname(path).length);
}

function resolveRelative(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  return withoutExt(normalize(join(dirname(from), specifier))).replace(
    /\/index$/,
    "",
  );
}

export function gatherEvidence(
  files: readonly SourceFile[],
  graph: ReadonlyMap<string, GraphFacts> = new Map(),
): Map<string, FileEvidence> {
  const importers = new Map<string, string[]>();
  for (const file of files) {
    for (const specifier of importsOf(file.text)) {
      const target = resolveRelative(file.path, specifier);
      if (target === undefined) continue;
      const list = importers.get(target) ?? [];
      list.push(file.path);
      importers.set(target, list);
    }
  }
  const out = new Map<string, FileEvidence>();
  for (const file of files) {
    const key = withoutExt(file.path).replace(/\/index$/, "");
    const body = file.text.replace(IMPORT, "").trim();
    out.set(file.path, {
      file: {
        path: file.path,
        exports: [...file.text.matchAll(EXPORT)]
          .map((m) => m[1] ?? "")
          .filter(Boolean),
        imports: importsOf(file.text),
        importedBySiblings: (importers.get(key) ?? []).map((p) => basename(p)),
        source:
          body.length <= SOURCE_LIMIT
            ? body
            : `${body.slice(0, SOURCE_LIMIT)}\n/* …truncated */`,
        ...(graph.has(file.path) ? { graph: graph.get(file.path) } : {}),
      },
    });
  }
  return out;
}
