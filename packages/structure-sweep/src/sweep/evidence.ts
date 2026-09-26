import { createHash } from "node:crypto";
import { basename, dirname, extname, join, normalize } from "node:path";
import { blobsAt, trackedPaths } from "../git.js";
import {
  type ModuleSyntax,
  readModule,
  resolvesNothing,
  type SpecifierResolver,
  staticDependencies,
} from "../module-syntax.js";
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

/**
 * Every non-test TypeScript source under `scope` as `ref` has it — the tree, not the working copy —
 * read in one `git cat-file --batch` however many files there are.
 */
export function listSources(
  cwd: string,
  ref: string,
  scope: string,
): SourceFile[] {
  const paths = trackedPaths(cwd, { ref }, scope).filter(isSweptSource);
  const blobs = blobsAt(cwd, ref, paths);
  return paths.map((path) => {
    const text = blobs.get(path);
    if (text === undefined) throw new Error(`${ref}:${path} was not read`);
    return { path, text, hash: contentHash(text) };
  });
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

const isSpace = (char: string | undefined) =>
  char !== undefined && /\s/.test(char);
const isLineEnd = (char: string | undefined) =>
  char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029";

/**
 * The text an import statement at `[start, end)` takes out of the source: its own line, from the
 * first line start after the code before it to just short of the last line end after it, so the
 * code around it keeps its line breaks. Never reaches below `floor`, where the previous one ended.
 */
function importLine(
  text: string,
  statement: { readonly start: number; readonly end: number },
  floor: number,
): { start: number; end: number } {
  let space = statement.start;
  while (space > floor && isSpace(text[space - 1])) space--;
  let start = statement.start;
  for (let at = space; at <= statement.start; at++)
    if (at === 0 || isLineEnd(text[at - 1])) {
      start = at;
      break;
    }
  let after = statement.end;
  while (after < text.length && isSpace(text[after])) after++;
  let end = statement.end;
  if (after === text.length) end = after;
  else
    for (let at = after - 1; at >= statement.end; at--)
      if (isLineEnd(text[at])) {
        end = at;
        break;
      }
  return { start, end };
}

const COUNTED = /^(.*?)( ×\d+)?$/;

/** One source file with what its module syntax says, parsed once for every use below. */
interface Parsed {
  readonly file: SourceFile;
  readonly syntax: ModuleSyntax;
}

/**
 * How one file's evidence names the files around it. `asNamed` is what the repo calls them;
 * `opaque` replaces every name with an id, so Jev judges the code and not its folder.
 */
interface Naming {
  path(path: string): string;
  sibling(path: string): string;
  specifier(from: string, specifier: string): string;
  graph(facts: GraphFacts): GraphFacts;
}

const asNamed: Naming = {
  path: (path) => path,
  sibling: (path) => basename(path),
  specifier: (_, specifier) => specifier,
  graph: (facts) => facts,
};

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Opaque ids for one input set: `f<n>` for a module (a swept file keeps its extension, a specifier
 * reads `./f<n>`), `g<n>` for a file a graph list names only by basename. A relative specifier is
 * numbered by the file it names; any other by where `resolve` leads it, so an alias naming a swept
 * file reads as that file's id and one leading nowhere known gets an id of its own. Only a
 * specifier leading into an install or a builtin stays as written. Ids follow code-unit order,
 * never the host locale's, so the same files and graph give the same ids on every machine.
 */
function opaque(
  parsed: readonly Parsed[],
  graph: ReadonlyMap<string, GraphFacts>,
  resolve: SpecifierResolver,
): Naming {
  const modules = new Map<string, number>();
  const number = (key: string) => {
    const n = modules.get(key) ?? modules.size + 1;
    modules.set(key, n);
    return n;
  };
  const keys = new Map<string, string | undefined>();
  const keyOf = (from: string, specifier: string): string | undefined => {
    const at = `${from}\0${specifier}`;
    if (keys.has(at)) return keys.get(at);
    const key = moduleKeyOf(from, specifier, resolve);
    keys.set(at, key);
    return key;
  };
  const sorted = [...parsed].sort((a, b) =>
    byCodeUnit(a.file.path, b.file.path),
  );
  for (const { file } of sorted) number(moduleKey(file.path));
  const targets = sorted.flatMap(({ file, syntax }) =>
    syntax.sites.flatMap((site) => {
      const key = keyOf(file.path, site.specifier);
      return key === undefined ? [] : [key];
    }),
  );
  for (const target of [...new Set(targets)].sort()) number(target);

  const graphNames = new Map<string, string>();
  const listed = sorted.flatMap(({ file }) => {
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
  const graphList = (list: readonly string[]) =>
    list.map((entry) => {
      const [, name = "", count = ""] = COUNTED.exec(entry) ?? [];
      return `${graphNames.get(name)}${count}`;
    });
  return {
    path,
    sibling: path,
    specifier: (from, spec) => {
      const key = keyOf(from, spec);
      return key === undefined ? spec : `./${idOf(key)}`;
    },
    graph: (facts) => ({
      ...facts,
      calledFromFiles: graphList(facts.calledFromFiles),
      callsFiles: graphList(facts.callsFiles),
    }),
  };
}

/**
 * The module a specifier is numbered by under `--redact`, or `undefined` when it stays as written.
 * A relative specifier names its file whatever the checkout holds; an unresolved one is keyed on
 * its own text, which no repo path can equal.
 */
function moduleKeyOf(
  from: string,
  specifier: string,
  resolve: SpecifierResolver,
): string | undefined {
  const relative = resolveRelative(from, specifier);
  if (relative !== undefined) return relative;
  const destination = resolve(from, specifier);
  switch (destination.kind) {
    case "repo":
      return moduleKey(destination.path);
    case "external":
      return undefined;
    case "unknown":
      return `\0${specifier}`;
  }
}

/**
 * The source Jev reads: every import statement's line taken out, every other specifier site named
 * through `naming`, trimmed. Sites are the parser's, so a comment or string that only looks like
 * an import stays as it is.
 */
function sourceBody({ file, syntax }: Parsed, naming: Naming): string {
  const { text } = file;
  const edits: { start: number; end: number; text: string }[] = [];
  let floor = 0;
  for (const statement of syntax.imports) {
    const line = importLine(text, statement, floor);
    edits.push({ ...line, text: "" });
    floor = line.end;
  }
  const removed = (at: number) =>
    edits.some((edit) => edit.start <= at && at < edit.end);
  for (const site of syntax.sites) {
    if (removed(site.start)) continue;
    const named = naming.specifier(file.path, site.specifier);
    if (named === site.specifier) continue;
    const quote = text[site.start] ?? '"';
    edits.push({
      start: site.start,
      end: site.end,
      text: `${quote}${named}${quote}`,
    });
  }
  edits.sort((a, b) => a.start - b.start);
  let body = "";
  let at = 0;
  for (const edit of edits) {
    body += text.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  return (body + text.slice(at)).trim();
}

/**
 * What stands in for the source of a file the parser could not read under `--redact`: its
 * specifier sites may be incomplete, so any line of it could still name a folder.
 */
export const UNPARSED_SOURCE =
  "/* source withheld: the file does not parse, so --redact cannot find every module specifier in it */";

/**
 * How evidence names things. `redact` shows opaque ids instead of names; `resolve` says where a
 * non-relative specifier leads, and without it every such specifier is hidden.
 */
export type EvidenceOptions =
  | { readonly redact?: false }
  | { readonly redact: true; readonly resolve?: SpecifierResolver };

export function gatherEvidence(
  files: readonly SourceFile[],
  graph: ReadonlyMap<string, GraphFacts> = new Map(),
  options: EvidenceOptions = {},
): Map<string, FileEvidence> {
  const parsed = files.map((file) => ({
    file,
    syntax: readModule(file.path, file.text),
  }));
  const naming = options.redact
    ? opaque(parsed, graph, options.resolve ?? resolvesNothing)
    : asNamed;
  const importers = new Map<string, string[]>();
  for (const { file, syntax } of parsed) {
    for (const specifier of staticDependencies(syntax)) {
      const target = resolveRelative(file.path, specifier);
      if (target === undefined) continue;
      const list = importers.get(target) ?? [];
      list.push(file.path);
      importers.set(target, list);
    }
  }
  const out = new Map<string, FileEvidence>();
  for (const entry of parsed) {
    const { file, syntax } = entry;
    const body =
      options.redact && !syntax.parsed
        ? UNPARSED_SOURCE
        : sourceBody(entry, naming);
    const facts = graph.get(file.path);
    out.set(file.path, {
      file: {
        path: naming.path(file.path),
        exports: [...syntax.exports],
        imports: staticDependencies(syntax).map((s) =>
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
