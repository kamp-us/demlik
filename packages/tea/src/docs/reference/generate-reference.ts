/**
 * The generated + drift-gated reference quadrant for `@demlik/tea`.
 *
 * `@demlik/tea` is a LIBRARY, so the reference is ONE PAGE PER PUBLIC MODULE
 * (every entry of `MODULE_ALLOWLIST`), never one page per symbol. The structured
 * source is the typedoc JSON model (`typedoc --json`), read once and rendered to
 * markdown by this module — never typedoc-plugin-markdown (the per-symbol
 * firehose).
 *
 * One generator builds a `Map<relPath, markdown>` from that model. A single
 * writer (`writeReferenceDocs`) and a single drift guard (`collectReferenceDrift`)
 * both consume the same map — no fact is produced twice. That map is the whole
 * truth of `docs/reference/`: the writer removes any file it did not write, and
 * `collectReferenceStrays` names one. The vitest gate in
 * `generate-reference.test.ts` runs the guards in CI and the writer under the
 * `TEA_DOCS_WRITE` env flag.
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Application, TSConfigReader, TypeDocReader } from "typedoc";
import { parseTierTable, type Tier, tierOf } from "./tier-table";
import {
  type DocModule,
  type DocSymbol,
  firstSentence,
  isRecord,
  parseTypedocModel,
} from "./typedoc-model";

/** packages/tea — this file lives at src/docs/reference/, three levels down. */
const PKG_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
/** Where the committed reference pages live (the drift baseline). */
export const REFERENCE_DIR = join(PKG_ROOT, "docs", "reference");
/** The typedoc JSON model — gitignored, regenerated on every run. */
const MODEL_JSON = join(PKG_ROOT, ".typedoc", "model.json");
const PACKAGE_JSON = join(PKG_ROOT, "package.json");
/** Holds the tier table — the one source of every tier a page prints. */
const MAINTAINING_MD = join(PKG_ROOT, "MAINTAINING.md");

/** A curated module group — governs the compass layout. */
type Group =
  | "Core"
  | "Adapters"
  | "Machines"
  | "Resilience"
  | "Batteries"
  | "Testing";

/**
 * One row of a page's start-here tier — the handful of symbols a newcomer reads
 * before the exhaustive table, which is alphabetical and so says nothing about
 * where to begin. Curated here rather than derived: "where a newcomer starts" is
 * an editorial fact no docblock carries.
 */
interface StartHere {
  /** Must name a symbol the module actually exports — checked at render. */
  readonly symbol: string;
  /** Why a reader picks this one, in one line. */
  readonly reachFor: string;
}

interface Curated {
  /** package.json exports subpath, e.g. "." or "./pbt". */
  readonly subpath: string;
  /** Import specifier shown on the page, e.g. "@demlik/tea/pbt". */
  readonly importPath: string;
  /** Output page filename under docs/reference/. */
  readonly file: string;
  /** typedoc module name — "index" for the root barrel, else the dir name. */
  readonly typedocName: string;
  readonly group: Group;
  /** Optional start-here tier, rendered above the exhaustive export table. */
  readonly startHere?: readonly StartHere[];
}

/**
 * MODULE_ALLOWLIST — the curated user-facing modules that each get a page.
 * Every OTHER export is plumbing, catalogued (not exploded) in all-modules.md.
 * This list is the single source of truth for the presentation layer; the
 * allowlist-integrity test asserts each subpath is a real package.json export.
 */
export const MODULE_ALLOWLIST: readonly Curated[] = [
  {
    subpath: ".",
    importPath: "@demlik/tea",
    file: "tea.md",
    typedocName: "index",
    group: "Core",
  },
  {
    subpath: "./promise",
    importPath: "@demlik/tea/promise",
    file: "promise.md",
    typedocName: "promise",
    group: "Core",
  },
  {
    subpath: "./effect",
    importPath: "@demlik/tea/effect",
    file: "effect.md",
    typedocName: "effect",
    group: "Core",
  },
  {
    subpath: "./react",
    importPath: "@demlik/tea/react",
    file: "react.md",
    typedocName: "react",
    group: "Adapters",
  },
  {
    subpath: "./do",
    importPath: "@demlik/tea/do",
    file: "do.md",
    typedocName: "do",
    group: "Adapters",
  },
  {
    subpath: "./node",
    importPath: "@demlik/tea/node",
    file: "node.md",
    typedocName: "node",
    group: "Adapters",
  },
  {
    subpath: "./mem",
    importPath: "@demlik/tea/mem",
    file: "mem.md",
    typedocName: "mem",
    group: "Adapters",
  },
  {
    subpath: "./extension",
    importPath: "@demlik/tea/extension",
    file: "extension.md",
    typedocName: "extension",
    group: "Adapters",
  },
  {
    subpath: "./agent",
    importPath: "@demlik/tea/agent",
    file: "agent.md",
    typedocName: "agent",
    group: "Machines",
    startHere: [
      {
        symbol: "defineAgent",
        reachFor:
          "You want an agent: a model, the tools it may call, instructions. This is the entry point — `run(input)` drives it to its finished state.",
      },
      {
        symbol: "tool",
        reachFor:
          "Declare one thing the model may call — its input/result schemas, the failures it may name, and the handler.",
      },
      {
        symbol: "ToolOutcome",
        reachFor:
          "Read what a settled call hands back, whether it succeeded or failed.",
      },
      {
        symbol: "DefinedAgentState",
        reachFor:
          "Type the Model a defined agent persists — what a `Store` reads and writes.",
      },
      {
        symbol: "createAgent",
        reachFor:
          "Drop below the lid, once you need to walk a stage pipeline `defineAgent` does not express.",
      },
    ],
  },
  {
    subpath: "./otel",
    importPath: "@demlik/tea/otel",
    file: "otel.md",
    typedocName: "otel",
    group: "Machines",
    startHere: [
      {
        symbol: "traceAgent",
        reachFor:
          "You hold an agent runtime and want each run in Langfuse, or any OpenTelemetry backend, as one span tree.",
      },
      {
        symbol: "agentSpans",
        reachFor:
          "The same span writer as an `onEvent` listener, for a `defineAgent` run.",
      },
    ],
  },
  {
    subpath: "./retry-backoff",
    importPath: "@demlik/tea/retry-backoff",
    file: "retry-backoff.md",
    typedocName: "retry-backoff",
    group: "Resilience",
  },
  {
    subpath: "./resilience",
    importPath: "@demlik/tea/resilience",
    file: "resilience.md",
    typedocName: "resilience",
    group: "Resilience",
  },
  {
    subpath: "./timing",
    importPath: "@demlik/tea/timing",
    file: "timing.md",
    typedocName: "timing",
    group: "Resilience",
  },
  {
    subpath: "./flow",
    importPath: "@demlik/tea/flow",
    file: "flow.md",
    typedocName: "flow",
    group: "Batteries",
  },
  {
    subpath: "./idempotency",
    importPath: "@demlik/tea/idempotency",
    file: "idempotency.md",
    typedocName: "idempotency",
    group: "Batteries",
  },
  {
    subpath: "./persistence",
    importPath: "@demlik/tea/persistence",
    file: "persistence.md",
    typedocName: "persistence",
    group: "Batteries",
  },
  {
    subpath: "./paginate",
    importPath: "@demlik/tea/paginate",
    file: "paginate.md",
    typedocName: "paginate",
    group: "Batteries",
  },
  {
    subpath: "./work-queue",
    importPath: "@demlik/tea/work-queue",
    file: "work-queue.md",
    typedocName: "work-queue",
    group: "Batteries",
  },
  {
    subpath: "./jev",
    importPath: "@demlik/tea/jev",
    file: "jev.md",
    typedocName: "jev",
    group: "Batteries",
  },
  {
    subpath: "./testing",
    importPath: "@demlik/tea/testing",
    file: "testing.md",
    typedocName: "testing",
    group: "Testing",
  },
  {
    subpath: "./testing/promise",
    importPath: "@demlik/tea/testing/promise",
    file: "testing-promise.md",
    typedocName: "testing/promise",
    group: "Testing",
  },
  {
    subpath: "./testing/effect",
    importPath: "@demlik/tea/testing/effect",
    file: "testing-effect.md",
    typedocName: "testing/effect",
    group: "Testing",
  },
  {
    subpath: "./pbt",
    importPath: "@demlik/tea/pbt",
    file: "pbt.md",
    typedocName: "pbt",
    group: "Testing",
  },
  {
    subpath: "./devtools",
    importPath: "@demlik/tea/devtools",
    file: "devtools.md",
    typedocName: "devtools",
    group: "Testing",
  },
  {
    subpath: "./machine-viz",
    importPath: "@demlik/tea/machine-viz",
    file: "machine-viz.md",
    typedocName: "machine-viz",
    group: "Testing",
  },
  {
    subpath: "./parity",
    importPath: "@demlik/tea/parity",
    file: "parity.md",
    typedocName: "parity",
    group: "Testing",
  },
];

const GROUP_ORDER: readonly Group[] = [
  "Core",
  "Adapters",
  "Machines",
  "Resilience",
  "Batteries",
  "Testing",
];

/** Read the parsed `package.json` for exports keys + version. */
async function readPackageJson(): Promise<{
  version: string;
  exports: Record<string, unknown>;
}> {
  const raw: unknown = JSON.parse(await readFile(PACKAGE_JSON, "utf8"));
  if (!isRecord(raw)) throw new Error("package.json: not an object");
  const { version, exports } = raw;
  if (typeof version !== "string")
    throw new Error("package.json: `version` is not a string");
  if (!isRecord(exports))
    throw new Error("package.json: `exports` is not an object");
  return { version, exports };
}

/** The set of public export subpaths (drives the allowlist-integrity test). */
export async function packageExportKeys(): Promise<string[]> {
  const { exports } = await readPackageJson();
  return Object.keys(exports);
}

/** Invoke typedoc to (re)emit the JSON model, then return the parsed modules. */
async function loadModel(): Promise<DocModule[]> {
  const app = await Application.bootstrapWithPlugins(
    { options: PKG_ROOT, logLevel: "Error" },
    [new TypeDocReader(), new TSConfigReader()],
  );
  const project = await app.convert();
  if (!project) throw new Error("typedoc: conversion failed (see logs above)");
  await app.generateJson(project, MODEL_JSON);
  const raw: unknown = JSON.parse(await readFile(MODEL_JSON, "utf8"));
  return parseTypedocModel(raw);
}

/** One row of a generated table: where it sits, what it names, what it says. */
export interface SummaryRow {
  /** The import path of a module page, or the catalog's filename. */
  readonly module: string;
  /** The exported symbol, or the subpath on a catalog row. */
  readonly symbol: string;
  readonly summary: string;
}

/**
 * Refuse a row with an empty summary. typedoc reads a TSDoc block and nothing
 * else, so a symbol documented with `//` renders a blank cell; the error names
 * every such row by module and symbol.
 */
export function assertEveryRowDescribed(rows: readonly SummaryRow[]): void {
  const empty = rows.filter((r) => r.summary.trim() === "");
  if (empty.length === 0) return;
  throw new Error(
    [
      `reference: ${empty.length} row(s) have no description. Add a /** */ summary to each (a // comment is not read):`,
      ...empty.map((r) => `  - ${r.module}: ${r.symbol}`),
    ].join("\n"),
  );
}

/** Escape a one-liner so it is safe inside a markdown table cell. */
function cell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/** First paragraph of a module summary, with the leading subpath + em-dash stripped. */
function tagline(summary: string): string {
  const firstPara = summary.split(/\n\s*\n/)[0] ?? "";
  const flat = firstPara.replace(/\s+/g, " ").trim();
  return flat.replace(/^@demlik\/tea[\w/-]*\s*[—-]\s*/, "").trim();
}

/**
 * The start-here tier, or nothing when the page curates none. A row naming a
 * symbol the module does not export is a hard error rather than a quiet skip:
 * that is exactly the drift this tier is here to survive.
 */
function renderStartHere(
  entry: Curated,
  symbols: readonly DocSymbol[],
): string[] {
  const rows = entry.startHere ?? [];
  if (rows.length === 0) return [];
  const exported = new Set(symbols.map((s) => s.name));
  for (const row of rows) {
    if (!exported.has(row.symbol)) {
      throw new Error(
        `start-here tier for '${entry.importPath}' names '${row.symbol}', which the module does not export`,
      );
    }
  }
  return [
    "## Start here",
    "",
    "The exports below are alphabetical, which says nothing about where to begin.",
    "These are the ones to read first:",
    "",
    "| Symbol | Reach for it when |",
    "| --- | --- |",
    ...rows.map((r) => `| ${symbolLink(r.symbol)} | ${cell(r.reachFor)} |`),
    "",
  ];
}

/** A link to a symbol's own entry on its module page. */
function symbolLink(name: string): string {
  return `[\`${cell(name)}\`](#${name})`;
}

/**
 * A symbol's tier: its module's, unless its own TSDoc says `@experimental`.
 * MAINTAINING.md stamps subpaths, and an export inherits its door's stamp; the
 * tag is how one export opts out of a promise its door makes.
 */
function symbolTier(symbol: DocSymbol, moduleTier: Tier): Tier {
  return symbol.experimental ? "experimental" : moduleTier;
}

/**
 * One entry per exported name: the anchor other pages link to, then what the
 * name declares. A type and a value exported under one name (`Cmd`) share the
 * entry, because they share the anchor — a name is what a link can point at.
 */
function renderDeclarations(symbols: readonly DocSymbol[]): string[] {
  const byName = new Map<string, string[]>();
  for (const s of symbols) {
    const declarations = byName.get(s.name) ?? [];
    if (s.declaration !== null) declarations.push(s.declaration);
    byName.set(s.name, declarations);
  }
  const lines: string[] = ["## Declarations", ""];
  for (const [name, declarations] of byName) {
    lines.push(`<a id="${name}"></a>`, "", `### \`${name}\``, "");
    if (declarations.length > 0) {
      lines.push("```ts", declarations.join("\n\n"), "```", "");
    }
  }
  return lines;
}

function renderModulePage(entry: Curated, mod: DocModule, tier: Tier): string {
  const intro = tagline(mod.summary);
  const symbols = [...mod.symbols].sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];
  lines.push(`# ${entry.importPath}`, "");
  if (intro) lines.push(`> ${intro}`, "");
  lines.push(`Tier: \`${tier}\``, "");
  lines.push("```ts", `import { … } from "${entry.importPath}";`, "```", "");
  lines.push(...renderStartHere(entry, symbols));
  lines.push(`## Exports (${symbols.length})`, "");
  if (symbols.length === 0) {
    lines.push("_No public exports._", "");
  } else {
    lines.push(
      "| Symbol | Kind | Tier | Summary |",
      "| --- | --- | --- | --- |",
    );
    for (const s of symbols) {
      lines.push(
        `| ${symbolLink(s.name)} | ${s.kindLabel} | ${symbolTier(s, tier)} | ${cell(s.summary)} |`,
      );
    }
    lines.push("", ...renderDeclarations(symbols));
  }
  return lines.join("\n");
}

function renderCompass(
  version: string,
  tiers: ReadonlyMap<string, Tier>,
): string {
  const lines: string[] = [];
  lines.push(
    "# @demlik/tea — reference",
    "",
    `Generated API reference for \`@demlik/tea\` **v${version}**.`,
    "",
    "One page per curated public module. Every export — including the plumbing",
    "subpaths that have no dedicated page — is listed in [all-modules.md](./all-modules.md).",
    "",
    "> Generated from the typedoc model. Do not edit by hand — run `pnpm --filter",
    "> @demlik/tea docs:reference` to regenerate.",
    "",
    "Each module is listed with its tier: `stable`, [`battery`](../glossary.md#battery) or `experimental`.",
    "",
    "The words these pages use (Model, Msg, Cmd, Sub, Store and the rest) are each",
    "defined in the [glossary](../glossary.md).",
    "",
  );
  for (const group of GROUP_ORDER) {
    const rows = MODULE_ALLOWLIST.filter((e) => e.group === group);
    if (rows.length === 0) continue;
    lines.push(`## ${group}`, "");
    for (const e of rows) {
      lines.push(
        `- [\`${e.importPath}\`](./${e.file}) — ${tierOf(tiers, e.subpath)}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Read a source barrel's leading `/** *​/` TSDoc and return its first sentence
 * — the one-line gloss for the catalog. Structured source (the module's own
 * TSDoc), not scraped output. Returns "" when the barrel has no block comment.
 */
async function barrelGloss(srcRelPath: string): Promise<string> {
  // A barrel may be `.ts` or `.tsx` — `subpathToSrc` cannot know which without
  // touching the filesystem, so the `.tsx` fallback lives here, where a read is
  // already happening. Generic rather than a per-module special case: any React
  // barrel added later gets its gloss for free.
  let text: string | undefined;
  for (const path of [srcRelPath, srcRelPath.replace(/\.ts$/, ".tsx")]) {
    try {
      text = await readFile(join(PKG_ROOT, path), "utf8");
      break;
    } catch {
      // try the next extension
    }
  }
  if (text === undefined) return "";
  // A stylesheet has no TSDoc; its leading plain block comment is its gloss.
  const block = text.match(
    srcRelPath.endsWith(".css") ? /\/\*([\s\S]*?)\*\// : /\/\*\*([\s\S]*?)\*\//,
  );
  if (!block?.[1]) return "";
  const body = block[1]
    .replace(/^\s*\*/gm, "")
    .replace(/@packageDocumentation|@module\b/g, "")
    .replace(/^@demlik\/tea[\w/-]*\s*[—-]\s*/, "")
    .replace(/@demlik\/tea[\w/-]*\s*[—-]\s*/, "");
  return firstSentence(body);
}

/** Map a package.json exports subpath to its source barrel path. */
function subpathToSrc(
  subpath: string,
  exports: Record<string, unknown>,
): string {
  const entry = exports[subpath];
  const imp =
    typeof entry === "string"
      ? entry
      : isRecord(entry) && typeof entry.import === "string"
        ? entry.import
        : "";
  // ./dist/foo/index.js -> src/foo/index.ts. A `.tsx` barrel
  // (extension/react) resolves in `barrelGloss`, which retries the other
  // extension rather than carrying a list of names that drifts.
  return imp.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts");
}

const CATALOG_FILE = "all-modules.md";
const COMPASS_FILE = "index.md";

/** One catalog row per public subpath: its name and its barrel's gloss. */
async function catalogRows(
  exports: Record<string, unknown>,
): Promise<SummaryRow[]> {
  const subpaths = Object.keys(exports)
    .filter((k) => k !== "./package.json")
    .sort();
  return Promise.all(
    subpaths.map(async (subpath) => ({
      module: CATALOG_FILE,
      symbol: subpath,
      summary: await barrelGloss(subpathToSrc(subpath, exports)),
    })),
  );
}

function renderCatalog(
  rows: readonly SummaryRow[],
  tiers: ReadonlyMap<string, Tier>,
): string {
  const pageBySubpath = new Map(
    MODULE_ALLOWLIST.map((e) => [e.subpath, e.file]),
  );
  const lines: string[] = [];
  lines.push(
    "# @demlik/tea — all modules",
    "",
    `The complete export catalog — all ${rows.length} public subpaths. Curated`,
    "modules link to their dedicated reference page; the rest are plumbing,",
    "discoverable here with a one-line gloss from their source barrel.",
    "",
    "| Subpath | Tier | Summary |",
    "| --- | --- | --- |",
  );
  for (const { symbol: subpath, summary } of rows) {
    const page = pageBySubpath.get(subpath);
    const label = page ? `[\`${subpath}\`](./${page})` : `\`${subpath}\``;
    lines.push(`| ${label} | ${tierOf(tiers, subpath)} | ${cell(summary)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Everything the pages are rendered from, read once. */
export interface ReferenceInputs {
  readonly modules: readonly DocModule[];
  readonly version: string;
  /** One row per public subpath, glossed from its source barrel. */
  readonly catalog: readonly SummaryRow[];
  /** Subpath → tier, as `MAINTAINING.md`'s tier table stamps it. */
  readonly tiers: ReadonlyMap<string, Tier>;
}

/** Read the typedoc model, the export map and the tier table. */
export async function loadReferenceInputs(): Promise<ReferenceInputs> {
  const [modules, pkg, maintaining] = await Promise.all([
    loadModel(),
    readPackageJson(),
    readFile(MAINTAINING_MD, "utf8"),
  ]);
  return {
    modules,
    version: pkg.version,
    catalog: await catalogRows(pkg.exports),
    tiers: parseTierTable(maintaining),
  };
}

/**
 * Render the full reference doc set as a `Map<relPath, markdown>`. This is the
 * single source both the writer and the drift guard consume.
 */
export function renderReferenceDocs(
  inputs: ReferenceInputs,
): Map<string, string> {
  const { modules, version, catalog, tiers } = inputs;
  const byName = new Map(modules.map((m) => [m.name, m]));
  const docs = new Map<string, string>();
  const rows: SummaryRow[] = [];
  for (const entry of MODULE_ALLOWLIST) {
    const mod = byName.get(entry.typedocName);
    if (!mod) {
      throw new Error(
        `typedoc model missing curated module '${entry.typedocName}' (${entry.subpath}) — check typedoc.json entryPoints`,
      );
    }
    docs.set(
      entry.file,
      renderModulePage(entry, mod, tierOf(tiers, entry.subpath)),
    );
    for (const s of mod.symbols) {
      rows.push({
        module: entry.importPath,
        symbol: s.name,
        summary: s.summary,
      });
    }
  }
  assertEveryRowDescribed([...rows, ...catalog]);
  docs.set(CATALOG_FILE, renderCatalog(catalog, tiers));
  docs.set(COMPASS_FILE, renderCompass(version, tiers));
  return docs;
}

/** Load the inputs and render them — the generated reference doc set. */
export async function generateReferenceDocs(): Promise<Map<string, string>> {
  return renderReferenceDocs(await loadReferenceInputs());
}

/**
 * Every filename the generator writes. Known without running typedoc, because
 * the allowlist fixes the page set — which is what lets the stray check run
 * without generating anything.
 */
export function referenceFileNames(): string[] {
  return [...MODULE_ALLOWLIST.map((e) => e.file), CATALOG_FILE, COMPASS_FILE];
}

/** Every file under `root`, as a `/`-separated path relative to it. */
async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) =>
      relative(root, join(e.parentPath, e.name)).split(sep).join("/"),
    );
}

/**
 * The files under `root` the generator does not write, sorted. A page whose
 * module left the allowlist is one; so is a file somebody dropped in by hand.
 * Empty means the directory holds the generated set and nothing else.
 */
export async function collectReferenceStrays(
  root: string = REFERENCE_DIR,
  generated: Iterable<string> = referenceFileNames(),
): Promise<string[]> {
  const written = new Set(generated);
  return (await listFiles(root)).filter((rel) => !written.has(rel)).sort();
}

/**
 * Write every generated page to disk (creates directories as needed), then
 * remove whatever else `root` holds: the directory is the generator's output and
 * nothing more.
 */
export async function writeReferenceDocs(
  root: string = REFERENCE_DIR,
): Promise<void> {
  const docs = await generateReferenceDocs();
  await mkdir(root, { recursive: true });
  for (const [rel, content] of docs) {
    const target = join(root, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  for (const stray of await collectReferenceStrays(root, docs.keys())) {
    await rm(join(root, stray));
  }
}

/** Read a page from disk, or `null` when it is missing (missing ⇒ drift). */
export async function defaultReadOnDisk(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The drift guard: regenerate in-memory and diff against disk. Returns the
 * sorted list of relative paths whose committed content differs from freshly
 * generated content — empty means the committed docs are in sync.
 */
export async function collectReferenceDrift(
  root: string = REFERENCE_DIR,
  readOnDisk: (path: string) => Promise<string | null> = defaultReadOnDisk,
): Promise<string[]> {
  const docs = await generateReferenceDocs();
  const drifted: string[] = [];
  for (const [rel, content] of docs) {
    const onDisk = await readOnDisk(join(root, rel));
    if (onDisk !== content) drifted.push(rel);
  }
  return drifted.sort();
}

export type { DocModule, DocSymbol };
