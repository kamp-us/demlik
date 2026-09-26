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

/**
 * One static import statement, bindings optional: `import … from "…"` across any number of lines, or
 * a bare `import "…"`. The bindings may not hold a quote, `;` or `(`, so a bare import never runs on
 * into the next statement's `from "…"`, and a dynamic `import("…")` is not a statement.
 */
const IMPORT = /^\s*import\b(?:[^;"'()]*?\bfrom)?\s*["']([^"']+)["'];?\s*$/gm;
const EXPORT =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm;

function importsOf(text: string): string[] {
  return [...text.matchAll(IMPORT)].map((m) => m[1] ?? "").filter(Boolean);
}

function withoutExt(path: string): string {
  return path.slice(0, path.length - extname(path).length);
}

/** The name a relative specifier resolves against: extension and a trailing `/index` dropped. */
const moduleKey = (path: string) =>
  withoutExt(normalize(path)).replace(/\/index$/, "");

function resolveRelative(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  return moduleKey(join(dirname(from), specifier));
}

/**
 * Every place a module specifier sits in source: `from "…"` (imports and re-exports), a bare
 * `import "…"`, a dynamic `import("…")` and `require("…")`. Only relative specifiers match.
 */
const RELATIVE_SITE =
  /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])(\.[^"']*)\2/g;

const COUNTED = /^(.*?)( ×\d+)?$/;

/**
 * How one file's evidence names the files around it. `asNamed` is what the repo calls them;
 * `opaque` replaces every name with an id, so Jev judges the code and not its folder.
 */
interface Naming {
  path(path: string): string;
  sibling(path: string): string;
  specifier(from: string, specifier: string): string;
  source(from: string, body: string): string;
  graph(facts: GraphFacts): GraphFacts;
}

const asNamed: Naming = {
  path: (path) => path,
  sibling: (path) => basename(path),
  specifier: (_, specifier) => specifier,
  source: (_, body) => body,
  graph: (facts) => facts,
};

/**
 * Opaque ids for one input set: `f<n>` for a module (a swept file keeps its extension, a specifier
 * reads `./f<n>`), `g<n>` for a file a graph list names only by basename. Ids follow code-unit
 * order, never the host locale's, so the same files and graph give the same ids on every machine.
 */
function opaque(
  files: readonly SourceFile[],
  graph: ReadonlyMap<string, GraphFacts>,
): Naming {
  const modules = new Map<string, number>();
  const number = (key: string) => {
    const n = modules.get(key) ?? modules.size + 1;
    modules.set(key, n);
    return n;
  };
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  for (const file of sorted) number(moduleKey(file.path));
  const targets = sorted.flatMap((file) =>
    [...file.text.matchAll(RELATIVE_SITE)].flatMap((m) => {
      const target = resolveRelative(file.path, m[3] ?? "");
      return target === undefined ? [] : [target];
    }),
  );
  for (const target of [...new Set(targets)].sort()) number(target);

  const graphNames = new Map<string, string>();
  const listed = sorted.flatMap((file) => {
    const facts = graph.get(file.path);
    return facts === undefined
      ? []
      : [...facts.calledFromFiles, ...facts.callsFiles];
  });
  const names = new Set(listed.map((entry) => COUNTED.exec(entry)?.[1] ?? ""));
  for (const name of [...names].sort())
    graphNames.set(name, `g${graphNames.size + 1}${extname(name)}`);

  const idOf = (key: string) => `f${number(key)}`;
  const path = (p: string) => `${idOf(moduleKey(p))}${extname(p)}`;
  const specifier = (from: string, spec: string) => {
    const target = resolveRelative(from, spec);
    return target === undefined ? spec : `./${idOf(target)}`;
  };
  const graphList = (list: readonly string[]) =>
    list.map((entry) => {
      const [, name = "", count = ""] = COUNTED.exec(entry) ?? [];
      return `${graphNames.get(name)}${count}`;
    });
  return {
    path,
    sibling: path,
    specifier,
    source: (from, body) =>
      body.replace(
        RELATIVE_SITE,
        (_, site: string, quote: string, spec: string) =>
          `${site}${quote}${specifier(from, spec)}${quote}`,
      ),
    graph: (facts) => ({
      ...facts,
      calledFromFiles: graphList(facts.calledFromFiles),
      callsFiles: graphList(facts.callsFiles),
    }),
  };
}

export interface EvidenceOptions {
  /** Name no path, folder, relative specifier or sibling file in the evidence — ids instead. */
  readonly redact?: boolean;
}

export function gatherEvidence(
  files: readonly SourceFile[],
  graph: ReadonlyMap<string, GraphFacts> = new Map(),
  options: EvidenceOptions = {},
): Map<string, FileEvidence> {
  const naming = options.redact ? opaque(files, graph) : asNamed;
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
    const body = naming.source(file.path, file.text.replace(IMPORT, "").trim());
    const facts = graph.get(file.path);
    out.set(file.path, {
      file: {
        path: naming.path(file.path),
        exports: [...file.text.matchAll(EXPORT)]
          .map((m) => m[1] ?? "")
          .filter(Boolean),
        imports: importsOf(file.text).map((s) =>
          naming.specifier(file.path, s),
        ),
        importedBySiblings: (importers.get(moduleKey(file.path)) ?? []).map(
          naming.sibling,
        ),
        source:
          body.length <= SOURCE_LIMIT
            ? body
            : `${body.slice(0, SOURCE_LIMIT)}\n/* …truncated */`,
        ...(facts !== undefined ? { graph: naming.graph(facts) } : {}),
      },
    });
  }
  return out;
}
