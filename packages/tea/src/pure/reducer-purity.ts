/**
 * Fold-purity static guard (#228) — TEA invariant 2 (pure reducers).
 *
 * The record→replay parity gate is only meaningful when `update` folds are
 * pure: `replay` re-runs `update`, so an impure reducer that mints an
 * id/timestamp (`Math.random`, `Date.now`, `new Date()`, `crypto.randomUUID`,
 * or an id-mint import) re-mints on every replay and defeats normalization
 * permanently — no diff-time id/timestamp stripping can recover it. This
 * module makes that leak fail loudly at dev time instead of silently rotting
 * a go/no-go parity gate months later.
 *
 * It is the sibling of `pure/import-graph.test.ts`: a text-level static scan
 * that asserts a boundary invariant. It scopes the scan to `update` reducer
 * BODIES, so the same banned call used legitimately at an interpret/config
 * boundary (`opts.rng ?? Math.random`) is never flagged — impurity belongs in
 * `interpret`, handed back as Msg data (invariant 3), which is exactly where
 * the fix message points.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** The single remediation every violation points at (invariant 3). */
export const FOLD_PURITY_FIX =
  "Move the impurity to `interpret` and hand the value back as Msg data (TEA invariant 3). Ids/timestamps that arrived as Msg payload are pure to read.";

export type BannedKind = "call" | "import";

/** A banned reducer-body call and its matcher. */
export interface BannedCall {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * The invariant-2 banned set. `new Date()` matches ONLY the zero-arg,
 * reads-current-time form — `new Date("2026-01-01")` / `new Date(epochMs)`
 * construct a known instant deterministically and are pure, so they are left
 * alone (the frozen-Msg-data carve-out).
 */
export const BANNED_CALLS: readonly BannedCall[] = [
  { name: "Math.random", pattern: /\bMath\s*\.\s*random\s*\(/g },
  { name: "Date.now", pattern: /\bDate\s*\.\s*now\s*\(/g },
  {
    name: "new Date() (reads current time)",
    pattern: /\bnew\s+Date\s*\(\s*\)/g,
  },
  { name: "crypto.randomUUID", pattern: /\bcrypto\s*\.\s*randomUUID\s*\(/g },
  {
    name: "crypto.getRandomValues",
    pattern: /\bcrypto\s*\.\s*getRandomValues\s*\(/g,
  },
];

/** Id-mint packages banned from any file that declares a reducer body. */
export const BANNED_IMPORTS: readonly string[] = ["uuid", "nanoid"];

/** Test / helper / fixture files the guard never scans (per acceptance). */
export const EXCLUDED_FILE =
  /\.test\.ts$|\.test-d\.ts$|\.type-test\.ts$|\.helpers\.ts$|__fixtures__/;

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly call: string;
  readonly kind: BannedKind;
  readonly message: string;
}

/**
 * Blank comments (always) and, when `strings` is set, string/template-literal
 * CONTENTS — newlines preserved, byte offsets kept — so a scan sees only the
 * code it should. String chars blank to `_`, NOT a space, so a deterministic
 * `new Date("2026-01-01")` never collapses to what looks like a zero-arg
 * `new Date()`; comments blank to spaces so their tokens dissolve entirely.
 *
 * Two callers, two needs: banned-call matching + reducer-body extraction want
 * strings gone (`strings: true`); import matching needs the module specifier
 * intact and only comments removed (`strings: false`).
 */
function scrub(src: string, strings: boolean): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let state: "code" | "line" | "block" | "str" = "code";
  let quote = "";
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    const fill = strings ? "_" : c;
    if (state === "code") {
      if (c === "/" && d === "/") {
        state = "line";
        out += "  ";
        i += 2;
      } else if (c === "/" && d === "*") {
        state = "block";
        out += "  ";
        i += 2;
      } else if (c === '"' || c === "'" || c === "`") {
        state = "str";
        quote = c;
        out += strings ? "_" : c;
        i += 1;
      } else {
        out += c;
        i += 1;
      }
    } else if (state === "line") {
      out += c === "\n" ? "\n" : " ";
      if (c === "\n") state = "code";
      i += 1;
    } else if (state === "block") {
      if (c === "*" && d === "/") {
        state = "code";
        out += "  ";
        i += 2;
      } else {
        out += c === "\n" ? "\n" : " ";
        i += 1;
      }
    } else {
      if (c === "\\") {
        out += strings ? "__" : src.slice(i, i + 2);
        i += 2;
      } else if (c === quote) {
        state = "code";
        out += strings ? "_" : c;
        i += 1;
      } else {
        out += c === "\n" ? "\n" : fill;
        i += 1;
      }
    }
  }
  return out;
}

/** Comments + string contents blanked — for body extraction + call matching. */
export function blankNonCode(src: string): string {
  return scrub(src, true);
}

/** Only comments blanked (string specifiers intact) — for import matching. */
export function blankComments(src: string): string {
  return scrub(src, false);
}

/** Index of the matching `}` for the `{` at `openIdx`, or -1 if unbalanced. */
function matchBalanced(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export interface Region {
  readonly start: number;
  readonly end: number;
}

/**
 * Reducer-body regions in already-blanked code. Two shapes cover how `update`
 * folds are written in the repo: an `update: { … }` object-literal property
 * (inside `defineMachine({ … })`) and a `: Reducer<…>` / `: Transitions<…>`
 * annotated binding assigned an object literal. `update: object` params and
 * `update as Reducer<…>` casts are NOT followed by `{`, so they are skipped.
 */
export function extractReducerBodies(blanked: string): readonly Region[] {
  const regions: Region[] = [];
  const push = (from: number) => {
    const open = blanked.indexOf("{", from);
    if (open < 0) return;
    const close = matchBalanced(blanked, open);
    if (close > open) regions.push({ start: open, end: close });
  };
  const propRe = /\bupdate\s*:\s*\{/g;
  for (let m = propRe.exec(blanked); m; m = propRe.exec(blanked)) push(m.index);
  const typedRe = /:\s*(?:Reducer|Transitions)\s*<[^=]*?=\s*\{/g;
  for (let m = typedRe.exec(blanked); m; m = typedRe.exec(blanked))
    push(m.index + m[0].length - 1);
  return regions;
}

function positionOf(
  src: string,
  idx: number,
): { line: number; column: number } {
  const before = src.slice(0, idx);
  const line = before.split("\n").length;
  const column = idx - (before.lastIndexOf("\n") + 1) + 1;
  return { line, column };
}

function violation(
  file: string,
  src: string,
  idx: number,
  call: string,
  kind: BannedKind,
): Violation {
  const { line, column } = positionOf(src, idx);
  const message = `${file}:${line}:${column} — impure ${kind} \`${call}\` inside an \`update\` reducer defeats record→replay parity. ${FOLD_PURITY_FIX}`;
  return { file, line, column, call, kind, message };
}

/**
 * Scan one source's reducer bodies for banned calls, plus its module imports
 * for banned id-mint packages (only when the file actually declares a reducer,
 * so a non-reducer util importing `uuid` is not flagged). `file` is the label
 * used in each violation message.
 */
export function scanReducerImpurity(
  source: string,
  file: string,
): readonly Violation[] {
  const blanked = blankNonCode(source);
  const bodies = extractReducerBodies(blanked);
  const found: Violation[] = [];
  for (const { start, end } of bodies) {
    for (const banned of BANNED_CALLS) {
      banned.pattern.lastIndex = 0;
      for (
        let m = banned.pattern.exec(blanked);
        m && m.index < end;
        m = banned.pattern.exec(blanked)
      ) {
        if (m.index >= start)
          found.push(violation(file, source, m.index, banned.name, "call"));
      }
    }
  }
  if (bodies.length > 0) {
    const alt = BANNED_IMPORTS.join("|");
    const importRe = new RegExp(
      `\\bfrom\\s*["'](${alt})(?:/[^"']*)?["']|\\bimport\\s*["'](${alt})(?:/[^"']*)?["']`,
      "g",
    );
    const forImports = blankComments(source);
    for (let m = importRe.exec(forImports); m; m = importRe.exec(forImports)) {
      const pkg = m[1] ?? m[2];
      found.push(violation(file, source, m.index, `import "${pkg}"`, "import"));
    }
  }
  return found;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (entry.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

/**
 * Walk `rootDir`, scan every production `.ts` file (test / helper / fixture
 * files excluded), and return every fold-purity violation, each labelled with
 * its path relative to `rootDir`.
 */
export function scanReducerFiles(rootDir: string): readonly Violation[] {
  const out: Violation[] = [];
  for (const file of walk(rootDir)) {
    if (EXCLUDED_FILE.test(file)) continue;
    out.push(
      ...scanReducerImpurity(
        readFileSync(file, "utf8"),
        relative(rootDir, file),
      ),
    );
  }
  return out;
}
