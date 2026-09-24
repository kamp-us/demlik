// Fail when a `.fabrika.jsonc` governed root has no control-plane row in `.github/CODEOWNERS`.
//
// This exists because the two drifted apart: the #307 monorepo move updated `governedRoots` to
// `packages/tea/package.json` and friends, CODEOWNERS kept the old root paths, and an export-map
// change (ADR 0010) could merge without control-plane review (#358). `governedRoots` is the source;
// CODEOWNERS follows it.
//
// A root passes when CODEOWNERS has a row whose pattern is exactly `/<root>` and whose owners
// include the control-plane team, and when no LATER row covering that root hands it to someone
// else — CODEOWNERS is last-match-wins, so a later row would silently take the review away.
//
// Run: node scripts/check-codeowners.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const OWNER = "@kamp-us/control-plane";
const CONFIG = ".fabrika.jsonc";
const CODEOWNERS = ".github/CODEOWNERS";

/** `.fabrika.jsonc` as JSON: comments dropped outside strings, then trailing commas. */
function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++)
        if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) throw new Error("unterminated block comment");
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function governedRoots() {
  const config = parseJsonc(readFileSync(path.join(REPO_ROOT, CONFIG), "utf8"));
  const roots = config.governedRoots;
  if (
    !Array.isArray(roots) ||
    roots.length === 0 ||
    !roots.every((r) => typeof r === "string")
  ) {
    throw new Error(`${CONFIG} has no non-empty string array at governedRoots`);
  }
  return roots;
}

/** CODEOWNERS rows in file order: `{ line, pattern, owners }`. */
function codeownersRows() {
  return readFileSync(path.join(REPO_ROOT, CODEOWNERS), "utf8")
    .split("\n")
    .map((text, i) => ({
      line: i + 1,
      fields: text.replace(/#.*/, "").trim().split(/\s+/),
    }))
    .filter(({ fields }) => fields[0] !== "")
    .map(({ line, fields: [pattern, ...owners] }) => ({
      line,
      pattern,
      owners,
    }));
}

/**
 * Does a row's pattern cover the governed root? Exact match, or an anchored directory pattern the
 * root sits under, or a catch-all. Other globs are not interpreted — this file does not use them,
 * and the exact-row rule below still binds.
 */
function covers(pattern, root) {
  const p = pattern.replace(/^\//, "");
  if (p === "*" || p === "**") return true;
  if (p === root) return true;
  return p.endsWith("/") && root.startsWith(p);
}

let roots;
let rows;
try {
  roots = governedRoots();
  rows = codeownersRows();
} catch (error) {
  console.error(
    `check-codeowners: could not read the inputs — ${error.message}`,
  );
  process.exit(1);
}

const failures = [];
for (const root of roots) {
  const exact = rows.find(
    (r) => r.pattern === `/${root}` && r.owners.includes(OWNER),
  );
  if (exact === undefined) {
    failures.push(`${root}: no \`/${root}  ${OWNER}\` row in ${CODEOWNERS}`);
    continue;
  }
  const last = rows.findLast((r) => covers(r.pattern, root));
  if (!last.owners.includes(OWNER)) {
    failures.push(
      `${root}: ${CODEOWNERS}:${last.line} \`${last.pattern}\` comes after the control-plane row and hands it to ${last.owners.join(" ") || "no owner"}`,
    );
  }
}

if (failures.length > 0) {
  console.error(
    `check-codeowners: ${CONFIG} governed roots without control-plane review\n`,
  );
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    `\n${failures.length} root(s). Add the row to ${CODEOWNERS}; do not drop the root from ${CONFIG}.`,
  );
  process.exit(1);
}

console.error(
  `check-codeowners: all ${roots.length} governed roots have a ${OWNER} row`,
);
