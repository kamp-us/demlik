import { stableStringify } from "../render/json.js";
import type {
  DeclarationKind,
  DeclarationNode,
  FunctionKind,
  FunctionNode,
  Graph,
  UseSite,
} from "../schema.js";

export type FindMatch = {
  id: string;
  name: string;
  kind: FunctionKind | DeclarationKind;
  file: string;
  line: number;
  isExported: boolean;
  uses: UseSite[] | null;
};

export type FindResult = {
  stdout: string | null;
  warning: string | null;
  exitCode: number;
};

// A function's uses are its call sites, one per caller line, where the caller is.
function callSites(fn: FunctionNode, fileOf: ReadonlyMap<string, string>): UseSite[] | null {
  if (fn.edges === null) return null;
  const sites = new Map<string, UseSite>();
  for (const { callerId, line } of fn.edges.calledBy) {
    const file = fileOf.get(callerId) ?? "";
    sites.set(`${file}:${line}`, { file, line });
  }
  return [...sites.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function functionMatch(fn: FunctionNode, fileOf: ReadonlyMap<string, string>): FindMatch {
  const { id, name, kind, file, startLine, isExported } = fn;
  return { id, name, kind, file, line: startLine, isExported, uses: callSites(fn, fileOf) };
}

function declarationMatch(node: DeclarationNode): FindMatch {
  const { id, name, kind, file, line, isExported, uses } = node;
  return { id, name, kind, file, line, isExported, uses };
}

export function findByName(graph: Graph, name: string): FindMatch[] {
  const fileOf = new Map(graph.functions.map((f) => [f.id, f.file]));
  return [
    ...graph.functions.filter((f) => f.name === name).map((f) => functionMatch(f, fileOf)),
    ...graph.declarations.filter((d) => d.name === name).map(declarationMatch),
  ].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id));
}

// `--find <name>`: every function and declaration node of that bare name, as data. Several
// matches are an answer, not an error, so the exit is 0 whatever the count.
export function renderFind(graph: Graph, name: string, pretty: boolean): FindResult {
  if (graph.provenance.pass !== "edges") {
    return {
      stdout: null,
      warning: "warning: --find requires the edge pass; this graph has none.",
      exitCode: 2,
    };
  }
  const matches = findByName(graph, name);
  const output = { name, scope: graph.provenance.scope, matches };
  const warning =
    matches.length === 0 ? `warning: no function or declaration is named "${name}".` : null;
  return { stdout: stableStringify(output, pretty), warning, exitCode: 0 };
}
