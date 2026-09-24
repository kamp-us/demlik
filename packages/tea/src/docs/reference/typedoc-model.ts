/**
 * Boundary parse for the typedoc JSON model.
 *
 * typedoc emits a large, loosely-typed JSON tree (`typedoc --json`). We never
 * trust it structurally — this module parses the raw `unknown` at the boundary
 * into the small, closed domain the reference generator actually consumes
 * (`DocModule` / `DocSymbol`), throwing on anything malformed. No `as` casts:
 * every field is checked with a type guard before it is read.
 */

/** A single exported symbol on a module page (one table row). */
export interface DocSymbol {
  readonly name: string;
  readonly kindLabel: string;
  /** One-line summary (first sentence of the symbol's TSDoc), possibly empty. */
  readonly summary: string;
}

/** A curated module: its own reference page. */
export interface DocModule {
  /** typedoc module name — "index" for the root barrel, else the dir name. */
  readonly name: string;
  /** The module-level TSDoc summary (from `@packageDocumentation`). */
  readonly summary: string;
  readonly symbols: readonly DocSymbol[];
}

// typedoc ReflectionKind is a numeric bitflag. Only the kinds a public module
// barrel can re-export at top level are mapped; anything else renders "Other".
const KIND_MODULE = 2;
const KIND_REFERENCE = 4194304;
const KIND_LABELS: ReadonlyMap<number, string> = new Map([
  [4, "Namespace"],
  [8, "Enum"],
  [32, "Variable"],
  [64, "Function"],
  [128, "Class"],
  [256, "Interface"],
  [2097152, "Type"],
  [4194304, "Reference"],
]);

export function kindLabel(kind: number): string {
  return KIND_LABELS.get(kind) ?? "Other";
}

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * The comment that documents a symbol. typedoc parks a function's TSDoc on its
 * first call signature rather than on the declaration reflection, so reading
 * only `sym.comment` leaves every documented function with an empty summary.
 * Prefer the declaration's own comment; fall back to the first signature's.
 */
function symbolComment(sym: Record<string, unknown>): unknown {
  if (isRecord(sym.comment)) return sym.comment;
  const [first] = Array.isArray(sym.signatures) ? sym.signatures : [];
  return isRecord(first) ? first.comment : undefined;
}

/** Flatten a typedoc `comment.summary` part array into plain text. */
function extractSummary(comment: unknown): string {
  if (!isRecord(comment)) return "";
  const { summary } = comment;
  if (!Array.isArray(summary)) return "";
  let out = "";
  for (const part of summary) {
    if (isRecord(part) && typeof part.text === "string") out += part.text;
  }
  return out.trim();
}

/**
 * Every reflection in the project, by id — the lookup {@link resolveReference}
 * needs. Built once per parse by walking the whole tree, because a reference
 * and its target routinely live on different modules.
 */
function indexById(
  root: Record<string, unknown>,
): Map<number, Record<string, unknown>> {
  const byId = new Map<number, Record<string, unknown>>();
  const visit = (node: unknown): void => {
    if (!isRecord(node)) return;
    if (typeof node.id === "number") byId.set(node.id, node);
    if (Array.isArray(node.children)) for (const c of node.children) visit(c);
  };
  visit(root);
  return byId;
}

/**
 * Follow a re-export to the declaration it names.
 *
 * typedoc emits a symbol as a `Reference` (kind 4194304) whenever the module
 * exporting it is not the module declaring it — which is what EVERY entry point
 * that re-exports another entry point's symbol produces. Read as-is, such a row
 * renders "Reference" with an empty summary: the reader is told the name exists
 * and nothing else, and the page silently got worse the moment a door opened
 * over a module another door already carried (#205).
 *
 * A re-export is the same declaration reached by another path, so the row
 * renders the TARGET's kind and TSDoc under the name the module exports it as.
 * A reference whose target is missing from the project — one pointing outside
 * it, the shape `excludeExternals` leaves behind — falls back to the reference
 * itself rather than throwing: an unresolvable pointer is a thin row, not a
 * malformed model.
 */
function resolveReference(
  sym: Record<string, unknown>,
  byId: ReadonlyMap<number, Record<string, unknown>>,
): Record<string, unknown> {
  const seen = new Set<number>();
  let current = sym;
  while (
    current.kind === KIND_REFERENCE &&
    typeof current.target === "number"
  ) {
    if (seen.has(current.target)) return current;
    seen.add(current.target);
    const next = byId.get(current.target);
    if (next === undefined) return current;
    current = next;
  }
  return current;
}

/**
 * Parse the raw typedoc project JSON into the curated module list. Throws a
 * descriptive error if the tree is not the expected `{ children: Module[] }`
 * shape — a malformed model must fail loudly, never silently emit empty docs.
 */
export function parseTypedocModel(raw: unknown): DocModule[] {
  if (!isRecord(raw) || !Array.isArray(raw.children)) {
    throw new Error(
      "typedoc model: expected an object with a `children` array",
    );
  }
  const byId = indexById(raw);
  const modules: DocModule[] = [];
  for (const child of raw.children) {
    if (!isRecord(child)) {
      throw new Error("typedoc model: a `children` entry is not an object");
    }
    if (typeof child.name !== "string" || typeof child.kind !== "number") {
      throw new Error("typedoc model: a module is missing `name`/`kind`");
    }
    if (child.kind !== KIND_MODULE) continue;
    const kids = Array.isArray(child.children) ? child.children : [];
    const symbols: DocSymbol[] = [];
    for (const sym of kids) {
      if (
        !isRecord(sym) ||
        typeof sym.name !== "string" ||
        typeof sym.kind !== "number"
      ) {
        throw new Error(
          `typedoc model: a symbol on module '${child.name}' is malformed`,
        );
      }
      // The name is the module's (that is how a consumer imports it); the kind
      // and the TSDoc are the declaration's, followed through any re-export.
      const decl = resolveReference(sym, byId);
      symbols.push({
        name: sym.name,
        kindLabel: kindLabel(
          typeof decl.kind === "number" ? decl.kind : sym.kind,
        ),
        summary: firstSentence(extractSummary(symbolComment(decl))),
      });
    }
    modules.push({
      name: child.name,
      summary: extractSummary(child.comment),
      symbols,
    });
  }
  return modules;
}

/** Collapse whitespace and take the first sentence of a TSDoc blob. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  const m = flat.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : flat).trim();
}
