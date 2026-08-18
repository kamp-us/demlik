/**
 * The generated + drift-gated reference quadrant for `@demlik/tea`.
 *
 * `@demlik/tea` is a LIBRARY, so the reference is ONE PAGE PER PUBLIC MODULE
 * (a curated ~19), never one page per symbol. The structured source is the
 * typedoc JSON model (`typedoc --json`), read once and rendered to markdown by
 * this module — never typedoc-plugin-markdown (the per-symbol firehose).
 *
 * One generator builds a `Map<relPath, markdown>` from that model. A single
 * writer (`writeReferenceDocs`) and a single drift guard (`collectReferenceDrift`)
 * both consume the same map — no fact is produced twice. The vitest gate in
 * `generate-reference.test.ts` runs the guard in CI and the writer under the
 * `TEA_DOCS_WRITE` env flag.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Application, TSConfigReader, TypeDocReader } from "typedoc";
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

/** A curated module group — governs the compass layout. */
type Group = "Core" | "Adapters" | "Machines" | "Resilience" | "Testing";

interface Curated {
  /** package.json exports subpath, e.g. "." or "./subs". */
  readonly subpath: string;
  /** Import specifier shown on the page, e.g. "@demlik/tea/subs". */
  readonly importPath: string;
  /** Output page filename under docs/reference/. */
  readonly file: string;
  /** typedoc module name — "index" for the root barrel, else the dir name. */
  readonly typedocName: string;
  readonly group: Group;
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
    subpath: "./subs",
    importPath: "@demlik/tea/subs",
    file: "subs.md",
    typedocName: "subs",
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
    subpath: "./work-queue",
    importPath: "@demlik/tea/work-queue",
    file: "work-queue.md",
    typedocName: "work-queue",
    group: "Adapters",
  },
  {
    subpath: "./agent",
    importPath: "@demlik/tea/agent",
    file: "agent.md",
    typedocName: "agent",
    group: "Machines",
  },
  {
    subpath: "./workflow",
    importPath: "@demlik/tea/workflow",
    file: "workflow.md",
    typedocName: "workflow",
    group: "Machines",
  },
  {
    subpath: "./saga",
    importPath: "@demlik/tea/saga",
    file: "saga.md",
    typedocName: "saga",
    group: "Machines",
  },
  {
    subpath: "./llm-call",
    importPath: "@demlik/tea/llm-call",
    file: "llm-call.md",
    typedocName: "llm-call",
    group: "Machines",
  },
  {
    subpath: "./retry-backoff",
    importPath: "@demlik/tea/retry-backoff",
    file: "retry-backoff.md",
    typedocName: "retry-backoff",
    group: "Resilience",
  },
  {
    subpath: "./circuit-breaker",
    importPath: "@demlik/tea/circuit-breaker",
    file: "circuit-breaker.md",
    typedocName: "circuit-breaker",
    group: "Resilience",
  },
  {
    subpath: "./with-resilience",
    importPath: "@demlik/tea/with-resilience",
    file: "with-resilience.md",
    typedocName: "with-resilience",
    group: "Resilience",
  },
  {
    subpath: "./testing",
    importPath: "@demlik/tea/testing",
    file: "testing.md",
    typedocName: "testing",
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
];

const GROUP_ORDER: readonly Group[] = [
  "Core",
  "Adapters",
  "Machines",
  "Resilience",
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

/** Escape a one-liner so it is safe inside a markdown table cell. */
function cell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/** First paragraph of a module summary, with the `@demlik/tea/x — ` lead stripped. */
function tagline(summary: string): string {
  const firstPara = summary.split(/\n\s*\n/)[0] ?? "";
  const flat = firstPara.replace(/\s+/g, " ").trim();
  return flat.replace(/^@demlik\/tea[\w/-]*\s*[—-]\s*/, "").trim();
}

function renderModulePage(entry: Curated, mod: DocModule): string {
  const intro = tagline(mod.summary);
  const symbols = [...mod.symbols].sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];
  lines.push(`# ${entry.importPath}`, "");
  if (intro) lines.push(`> ${intro}`, "");
  lines.push("```ts", `import { … } from "${entry.importPath}";`, "```", "");
  lines.push(`## Exports (${symbols.length})`, "");
  if (symbols.length === 0) {
    lines.push("_No public exports._", "");
  } else {
    lines.push("| Symbol | Kind | Summary |", "| --- | --- | --- |");
    for (const s of symbols) {
      lines.push(
        `| \`${cell(s.name)}\` | ${s.kindLabel} | ${cell(s.summary)} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderCompass(version: string): string {
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
  );
  for (const group of GROUP_ORDER) {
    const rows = MODULE_ALLOWLIST.filter((e) => e.group === group);
    if (rows.length === 0) continue;
    lines.push(`## ${group}`, "");
    for (const e of rows) {
      lines.push(`- [\`${e.importPath}\`](./${e.file})`);
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
  const block = text.match(/\/\*\*([\s\S]*?)\*\//);
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
  // ./dist/foo/index.js -> src/foo/index.ts. A `.tsx` barrel (extension/react,
  // chart/inspect/react) resolves in `barrelGloss`, which retries the other
  // extension rather than carrying a list of names that drifts.
  return imp.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts");
}

async function renderCatalog(
  exports: Record<string, unknown>,
): Promise<string> {
  const pageBySubpath = new Map(
    MODULE_ALLOWLIST.map((e) => [e.subpath, e.file]),
  );
  const subpaths = Object.keys(exports)
    .filter((k) => k !== "./package.json")
    .sort();
  const lines: string[] = [];
  lines.push(
    "# @demlik/tea — all modules",
    "",
    `The complete export catalog — all ${subpaths.length} public subpaths. Curated`,
    "modules link to their dedicated reference page; the rest are plumbing,",
    "discoverable here with a one-line gloss from their source barrel.",
    "",
    "| Subpath | Summary |",
    "| --- | --- |",
  );
  for (const subpath of subpaths) {
    const src = subpathToSrc(subpath, exports);
    const gloss = src.endsWith(".css") ? "" : await barrelGloss(src);
    const page = pageBySubpath.get(subpath);
    const label = page ? `[\`${subpath}\`](./${page})` : `\`${subpath}\``;
    lines.push(`| ${label} | ${cell(gloss)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Build the full reference doc set as a `Map<relPath, markdown>`. This is the
 * single source both the writer and the drift guard consume.
 */
export async function generateReferenceDocs(): Promise<Map<string, string>> {
  const [modules, pkg] = await Promise.all([loadModel(), readPackageJson()]);
  const byName = new Map(modules.map((m) => [m.name, m]));
  const docs = new Map<string, string>();
  for (const entry of MODULE_ALLOWLIST) {
    const mod = byName.get(entry.typedocName);
    if (!mod) {
      throw new Error(
        `typedoc model missing curated module '${entry.typedocName}' (${entry.subpath}) — check typedoc.json entryPoints`,
      );
    }
    docs.set(entry.file, renderModulePage(entry, mod));
  }
  docs.set("all-modules.md", await renderCatalog(pkg.exports));
  docs.set("index.md", renderCompass(pkg.version));
  return docs;
}

/** Write every generated page to disk (creates directories as needed). */
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
