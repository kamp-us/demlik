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
      symbols.push({
        name: sym.name,
        kindLabel: kindLabel(sym.kind),
        summary: firstSentence(extractSummary(sym.comment)),
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
