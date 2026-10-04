import { accessOf } from "../../data/access.js";
import { bindingSites } from "../../data/extract.js";
import { ownerOf } from "../../extract/cross-runtime.js";
import type { BindingCatalog } from "../../extract/wrangler-config.js";
import type { ImportEdge } from "../../schema.js";
import type { SyntaxFile } from "../../syntax/file.js";
import type { BindingSite } from "../deployables/deployables.js";
import { importTargetOf, type Libraries } from "../libraries/libraries.js";
import { inScope } from "../rules.js";
import type { WriteSite } from "../violation.js";

// The read allowance of a scope: the driven files a driving adapter may import (B8's exception),
// and the library types whose runtime import beside one says the decision was made in the core.
// `decidedBy` is null when the declaration left it out: the reads of the scope decide nothing.
export type ScopeAllowance = {
  readonly driven: ReadonlySet<string>;
  readonly decidedBy: ReadonlySet<string> | null;
};

// The allowances a rules file declares, by scope, read once for the run beside the wrangler
// catalog that says which bindings a listed file's worker has.
export type ReadAllowance = {
  readonly scopes: ReadonlyMap<string, ScopeAllowance>;
  readonly catalog: BindingCatalog;
};

type Declared = Readonly<
  Record<
    string,
    { readonly driven: readonly string[]; readonly decidedBy?: readonly string[] | undefined }
  >
>;

export function readAllowanceOf(declared: Declared, catalog: BindingCatalog): ReadAllowance {
  const scopes = Object.entries(declared).map(
    ([scope, { driven, decidedBy }]) =>
      [
        scope,
        { driven: new Set(driven), decidedBy: decidedBy === undefined ? null : new Set(decidedBy) },
      ] as const,
  );
  return { scopes: new Map(scopes), catalog };
}

// The listed files of a scope that the scope did not load: a stale or mistyped file would silently
// grant nothing. `files` is every scope-relative file the scope loaded.
export function unknownDriven(
  allowance: ReadAllowance,
  scope: string,
  files: ReadonlySet<string>,
): string[] {
  const listed = allowance.scopes.get(scope)?.driven ?? new Set<string>();
  return [...listed].filter((file) => !files.has(file));
}

// The first data write a listed driven file makes, in source order: a call that the Workers
// runtime API says writes (`accessOf`, as `--data` computes it) through a data binding the worker
// that owns the file declares. A file the scope does not list, or a worker with no data binding,
// has none, and neither does a site `accessOf` calls `unknown` (a non-literal SQL string, a
// Durable Object stub): the tool names a write only where it can see one.
export function firstWrite(
  allowance: ReadAllowance,
  scope: string,
  file: string,
  syntax: SyntaxFile,
): BindingSite | null {
  if (allowance.scopes.get(scope)?.driven.has(file) !== true) return null;
  const worker = ownerOf(allowance.catalog.manifests, inScope(scope, file));
  if (worker === null || worker.dataBindings.length === 0) return null;
  const bindings = new Map(worker.dataBindings.map((decl) => [decl.binding, decl]));
  const writes = bindingSites(syntax, bindings)
    .filter((site) => accessOf(site.decl.kind, site.method, site.sql) === "write")
    .sort((a, b) => a.line - b.line || a.column - b.column);
  const [first] = writes;
  return first === undefined ? null : { binding: first.decl.binding, line: first.line };
}

// What the allowance facts of one scope are: its allowance, and the first write of each listed
// file the scope loaded, by scope-relative file.
export type ScopeReads = {
  readonly allowance: ScopeAllowance;
  readonly writes: ReadonlyMap<string, WriteSite>;
};

export function scopeReadsOf(
  allowance: ReadAllowance,
  scope: string,
  modules: readonly { readonly file: string; readonly firstWrite: BindingSite | null }[],
): ScopeReads | null {
  const own = allowance.scopes.get(scope);
  if (own === undefined) return null;
  const writes = modules.flatMap(({ file, firstWrite: write }) =>
    write === null ? [] : [[file, { file: inScope(scope, file), ...write }] as const],
  );
  return { allowance: own, writes: new Map(writes) };
}

// Whether the allowance licenses a driving file's import of a driven file. When it does not and the
// reason is a write, the write rides along: the report names it.
export type DrivenVerdict =
  | { readonly licensed: true }
  | { readonly licensed: false; readonly write?: WriteSite };

export type DrivenReads = (target: string) => DrivenVerdict;

const UNLICENSED: DrivenVerdict = { licensed: false };
const LICENSED: DrivenVerdict = { licensed: true };

// Whether a file imports, when it runs, a library whose type is one of `decidedBy`: `import type`
// holds no decision, and `runtimeSpecifiers` says which specifiers the file runs.
function decides(
  module: {
    readonly importEdges: readonly Pick<ImportEdge, "specifier">[];
    readonly runtimeSpecifiers: ReadonlySet<string>;
  },
  libraries: Libraries,
  decidedBy: ReadonlySet<string>,
): boolean {
  return module.importEdges.some((edge) => {
    if (!module.runtimeSpecifiers.has(edge.specifier)) return false;
    const target = importTargetOf(libraries, edge.specifier);
    return target.kind === "library" && decidedBy.has(target.type);
  });
}

// B8's exception for one driving file. A listed file that writes is never licensed, whoever imports
// it: a write goes through the application. A listed file that only reads is licensed for a file
// that also decides, which is where the decision lives, or for any file when the scope names no
// `decidedBy` (review holds that its adapters decide nothing). Anything else is B8 as before.
export function drivenReadsOf(
  reads: ScopeReads | null,
  module: Parameters<typeof decides>[0],
  libraries: Libraries,
): DrivenReads {
  if (reads === null) return () => UNLICENSED;
  let decided: boolean | undefined;
  return (target) => {
    if (!reads.allowance.driven.has(target)) return UNLICENSED;
    const write = reads.writes.get(target);
    if (write !== undefined) return { licensed: false, write };
    const { decidedBy } = reads.allowance;
    if (decidedBy === null) return LICENSED;
    decided ??= decides(module, libraries, decidedBy);
    return decided ? LICENSED : UNLICENSED;
  };
}
