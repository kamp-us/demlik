import type { DiscoveredDeclaration } from "../declarations/discover.js";
import type { ExportedSymbolKind, FunctionNode, UnusedExport, UseSite } from "../schema.js";

// What the edge pass measured about who uses an export. A symbol `usesById` holds no entry for
// never joined tsgo's tree, so its uses are unknown and it is never a finding.
export type ExportEvidence = {
  readonly declarations: readonly DiscoveredDeclaration[];
  // Checker-resolved use sites per declaration and per exported function node.
  readonly usesById: ReadonlyMap<string, readonly UseSite[]>;
  // File → the other files that take all of its exports at once (`import * as`, `export *`).
  readonly wholeModuleUsers: ReadonlyMap<string, ReadonlySet<string>>;
};

export type ExportedSymbol = {
  readonly id: string;
  readonly file: string;
  readonly startLine: number;
  readonly symbolKind: ExportedSymbolKind;
  // A platform or tool loads it by name, so no importer is expected.
  readonly isEntry: boolean;
};

// A class whose body holds a function the kinds pass made an entry: a platform instantiates it
// (a Durable Object, a WorkerEntrypoint) to call that method.
function holdsEntry(
  declaration: DiscoveredDeclaration,
  entriesByFile: ReadonlyMap<string, readonly FunctionNode[]>,
): boolean {
  if (declaration.kind !== "class") return false;
  return (entriesByFile.get(declaration.file) ?? []).some(
    (fn) => fn.startLine >= declaration.line && fn.endLine <= declaration.endLine,
  );
}

function entriesByFile(functions: readonly FunctionNode[]): Map<string, FunctionNode[]> {
  const out = new Map<string, FunctionNode[]>();
  for (const fn of functions) {
    if (fn.nodeKind?.kind !== "entry") continue;
    const bucket = out.get(fn.file);
    if (bucket === undefined) out.set(fn.file, [fn]);
    else bucket.push(fn);
  }
  return out;
}

// Every exported, non-test function and declaration node. A function is an entry when the kinds
// pass classified it so; a declaration when it is a class holding such an entry, or when
// `isEntryDeclaration` says a platform or framework loads it by name.
export function exportedSymbols(
  functions: readonly FunctionNode[],
  declarations: readonly DiscoveredDeclaration[],
  isEntryDeclaration: (declaration: DiscoveredDeclaration) => boolean,
): ExportedSymbol[] {
  const entries = entriesByFile(functions);
  const out: ExportedSymbol[] = [];
  for (const fn of functions) {
    if (!fn.isExported || fn.isTest) continue;
    out.push({
      id: fn.id,
      file: fn.file,
      startLine: fn.startLine,
      symbolKind: "function",
      isEntry: fn.nodeKind?.kind === "entry",
    });
  }
  for (const d of declarations) {
    if (!d.isExported || d.isTest) continue;
    out.push({
      id: d.id,
      file: d.file,
      startLine: d.line,
      symbolKind: d.kind,
      isEntry: holdsEntry(d, entries) || isEntryDeclaration(d),
    });
  }
  return out;
}

export type UnusedExportScope = {
  readonly surface: ReadonlySet<string>;
  readonly isTestLike: (file: string) => boolean;
  // Symbols that already carry a stronger finding (`dead`, `only-called-from-tests`).
  readonly reported: ReadonlySet<string>;
};

function usedElsewhere(symbol: ExportedSymbol, evidence: ExportEvidence): boolean | null {
  const sites = evidence.usesById.get(symbol.id);
  if (sites === undefined) return null;
  if (sites.some((site) => site.file !== symbol.file)) return true;
  return (evidence.wholeModuleUsers.get(symbol.file)?.size ?? 0) > 0;
}

function isCandidate(symbol: ExportedSymbol, scope: UnusedExportScope): boolean {
  return (
    !symbol.isEntry &&
    !scope.reported.has(symbol.id) &&
    !scope.surface.has(symbol.file) &&
    !scope.isTestLike(symbol.file)
  );
}

// An export outside the public surface that no other loaded file uses: no import, re-export or
// other checker-resolved reference from a test or a production file. Sorted by id.
export function findUnusedExports(
  symbols: readonly ExportedSymbol[],
  evidence: ExportEvidence,
  scope: UnusedExportScope,
): UnusedExport[] {
  const out: UnusedExport[] = [];
  for (const symbol of symbols) {
    if (!isCandidate(symbol, scope) || usedElsewhere(symbol, evidence) !== false) continue;
    const { id, file, startLine, symbolKind } = symbol;
    out.push({ id, file, startLine, symbolKind });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
