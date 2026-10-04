/**
 * The link gate (#356, #537).
 *
 * The package's published markdown links to files in this repo two ways: by
 * relative path, and by a GitHub URL into this repo's own `main` tree, which is
 * the only form that works from the npm page. Nothing renders either before a
 * reader clicks one. This module reads every such link out of that markdown and
 * answers which ones name a file that is not there. Every other external link
 * (`https:`, `mailto:`, …), site-rooted paths and in-page anchors are not its
 * business, and it reads the disk only, never the network.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** packages/tea — this file lives at src/docs/, two levels down. */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The repo root — packages/tea sits two levels below it. */
const REPO_ROOT = join(PKG_ROOT, "..", "..");

/** The package-root pages a reader meets on npm and GitHub. */
const ROOT_PAGES = ["CHANGELOG.md", "README.md", "MAINTAINING.md"];

/** What may follow an inline link's destination: an optional title, then `)`. */
const LINK_TAIL =
  /^[ \t]*(?:(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\))[ \t]*)?\)/;
/** A backslash escape of an ASCII punctuation character. */
const ESCAPE = /\\([!-/:-@[-`{-~])/g;
/** `[label]: target`, a reference definition on its own line. */
const REFERENCE_DEF = /^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/;
/** A target that names a scheme (`https:`, `mailto:`) is not a file path. */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** A GitHub URL into this repo's `main` tree; the capture is the path from the repo root. */
const REPO_TREE =
  /^https:\/\/github\.com\/kamp-us\/demlik\/(?:blob|tree)\/main\/(.+)$/i;
/** A fence opener or closer: three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** An inline code span, which may wrap lines but never crosses a blank one. */
const CODE_SPAN = /(`+)(?:(?!\n\s*\n)[\s\S])*?\1/g;

/** One link that resolves to nothing on disk. */
export interface LinkHit {
  /** Package-relative path of the page carrying the link. */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  /** The link target as the page spells it. */
  readonly target: string;
}

/**
 * The file path a link target names, or `undefined` when it names no file:
 * an external URL, a site-rooted path, or an anchor within the page.
 */
export function filePathOf(target: string): string | undefined {
  if (SCHEME.test(target) || target.startsWith("/")) return undefined;
  return pathPart(target);
}

/**
 * The path, from the repo root, that a GitHub URL into this repo's `main` tree
 * names (`blob/main/<path>` or `tree/main/<path>`), or `undefined` for any
 * other target: another host, another repo, another ref.
 */
export function repoPathOf(target: string): string | undefined {
  const path = REPO_TREE.exec(target)?.[1];
  return path === undefined ? undefined : pathPart(path);
}

/** A target without its fragment and query, unescaped; `undefined` when nothing is left. */
function pathPart(target: string): string | undefined {
  const path = target.split("#")[0]?.split("?")[0] ?? "";
  return path === "" ? undefined : decodeURI(path.replace(ESCAPE, "$1"));
}

/** Where on disk a target points: from `repoRoot` for a repo URL, else from the page. */
function resolvedFileOf(
  target: string,
  file: string,
  repoRoot: string,
): string | undefined {
  const fromRepo = repoPathOf(target);
  if (fromRepo !== undefined) return resolve(repoRoot, fromRepo);
  const fromPage = filePathOf(target);
  return fromPage === undefined ? undefined : resolve(dirname(file), fromPage);
}

/**
 * Pure core: the links in `source` that `exists` says resolve to nothing.
 * `file` is the page's own path, which relative targets resolve from;
 * `repoRoot` is where a URL into this repo's tree resolves from. Links inside
 * fenced code and inline code spans are code, not links.
 */
export function brokenLinksIn(
  file: string,
  source: string,
  exists: (path: string) => boolean,
  repoRoot: string,
): readonly LinkHit[] {
  const hits: LinkHit[] = [];
  proseLines(source).forEach((text, index) => {
    const targets = inlineTargets(text);
    const definition = REFERENCE_DEF.exec(text)?.[1];
    if (definition !== undefined) targets.push(definition);
    for (const target of targets) {
      const path = resolvedFileOf(target, file, repoRoot);
      if (path !== undefined && !exists(path))
        hits.push({ file, line: index + 1, target });
    }
  });
  return hits;
}

/**
 * The destination of every `[text](target "title")` and `![alt](target)` on a
 * line, as the page spells it. A destination is read the CommonMark way: in
 * `<…>` it runs to the closing `>`; bare, it runs to whitespace or to the `)`
 * that closes the link, so balanced parentheses inside it (`./a_(b).md`) and
 * escaped ones (`./a\\).md`) stay part of the path.
 */
export function inlineTargets(line: string): string[] {
  const targets: string[] = [];
  for (
    let open = line.indexOf("](");
    open !== -1;
    open = line.indexOf("](", open + 1)
  ) {
    let at = open + 2;
    while (line[at] === " " || line[at] === "\t") at++;
    let target = "";
    if (line[at] === "<") {
      const close = line.indexOf(">", at + 1);
      if (close === -1) continue;
      target = line.slice(at + 1, close);
      if (target.includes("<")) continue;
      at = close + 1;
    } else {
      const start = at;
      let depth = 0;
      for (; at < line.length; at++) {
        const ch = line[at] ?? "";
        if (ch === "\\" && at + 1 < line.length) at++;
        else if (ch === "(") depth++;
        else if (ch === ")" && depth-- === 0) break;
        else if (/\s/.test(ch)) break;
      }
      if (depth > 0) continue;
      target = line.slice(start, at);
    }
    if (target !== "" && LINK_TAIL.test(line.slice(at))) targets.push(target);
  }
  return targets;
}

/**
 * The page's lines with every fenced block and code span blanked, so what is
 * left is prose and a line number still names the source line.
 */
function proseLines(source: string): string[] {
  let fence: string | undefined;
  const unfenced = source.split("\n").map((text) => {
    const opener = FENCE.exec(text)?.[1];
    if (opener !== undefined) {
      if (fence === undefined) fence = opener;
      else if (opener[0] === fence[0] && opener.length >= fence.length)
        fence = undefined;
      return "";
    }
    return fence === undefined ? text : "";
  });
  return unfenced
    .join("\n")
    .replace(CODE_SPAN, (span) => span.replace(/[^\n]/g, " "))
    .split("\n");
}

/** The pages the gate reads: the package-root pages and every `.md` under `docs/`. */
export async function linkedPages(): Promise<readonly string[]> {
  const found = ROOT_PAGES.map((name) => join(PKG_ROOT, name));
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".md")) found.push(path);
    }
  };
  await walk(join(PKG_ROOT, "docs"));
  return found.sort();
}

/** Every link in the gated pages that names a missing file. */
export async function collectBrokenLinks(): Promise<readonly LinkHit[]> {
  const hits: LinkHit[] = [];
  for (const page of await linkedPages()) {
    const source = await readFile(page, "utf8");
    for (const hit of brokenLinksIn(page, source, existsSync, REPO_ROOT))
      hits.push({ ...hit, file: relative(PKG_ROOT, hit.file) });
  }
  return hits;
}

/** One hit per line, in the `file:line — target` shape a failure should read as. */
export function formatBrokenLinks(hits: readonly LinkHit[]): string {
  return hits
    .map((h) => `  ${h.file}:${h.line} — ${h.target} resolves to nothing`)
    .join("\n");
}
