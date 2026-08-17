// Assert every published subpath carries a tier stamp.
//
// MAINTAINING.md says an export "is not done until it has a row here", and this is
// the check that makes that true rather than aspirational. It cross-references two
// sources that are edited independently and drift apart silently:
//
//   - package.json `exports` — what actually ships
//   - MAINTAINING.md's tier table — what promise each subpath carries
//
// A subpath added to the export map without a row is an unstamped public API: it
// ships with no stability promise stated, and nobody notices until a consumer asks.
// A row for a subpath that no longer exists is a promise about nothing.
//
// Run: node scripts/check-export-stamps.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const TIERS = new Set(["stable", "battery", "experimental"]);

/** Rows of MAINTAINING.md's "every published subpath" table. */
function readTierTable() {
  const md = readFileSync(path.join(REPO_ROOT, "MAINTAINING.md"), "utf8");
  const rows = new Map();
  for (const m of md.matchAll(
    /^\|\s*`(\.[^`]*)`\s*\|\s*([a-z]+)\s*\|\s*(.*?)\s*\|\s*$/gm,
  )) {
    const [, subpath, tier, note] = m;
    if (!TIERS.has(tier)) continue;
    rows.set(subpath, { tier, note });
  }
  return rows;
}

/**
 * Subpaths the package exports as API. `./package.json` is metadata passthrough and
 * `*.css` entries are assets, so neither carries a stability promise of its own.
 */
function readExportMap() {
  const pkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  );
  return Object.keys(pkg.exports).filter(
    (k) => k !== "./package.json" && !k.endsWith(".css"),
  );
}

const stamps = readTierTable();
const exported = readExportMap();

const unstamped = exported.filter((s) => !stamps.has(s));
const orphaned = [...stamps.keys()].filter(
  (s) => !exported.includes(s) && s !== "./package.json" && !s.endsWith(".css"),
);

if (unstamped.length === 0 && orphaned.length === 0) {
  const counts = exported.reduce((acc, s) => {
    const { tier } = stamps.get(s);
    acc[tier] = (acc[tier] ?? 0) + 1;
    return acc;
  }, {});
  const summary = [...TIERS].map((t) => `${counts[t] ?? 0} ${t}`).join(" · ");
  console.log(`check-export-stamps: ${exported.length} subpaths — ${summary}`);
  process.exit(0);
}

if (unstamped.length > 0) {
  console.error(
    `check-export-stamps: ${unstamped.length} exported subpath(s) have no tier ` +
      `stamp in MAINTAINING.md:\n` +
      unstamped.map((s) => `  ${s}`).join("\n") +
      `\n\nAdd a row to the tier table. An export is not done until it has one.`,
  );
}
if (orphaned.length > 0) {
  console.error(
    `\ncheck-export-stamps: ${orphaned.length} tier-table row(s) name a subpath ` +
      `the package no longer exports:\n` +
      orphaned.map((s) => `  ${s}`).join("\n") +
      `\n\nRemove the row, or restore the export.`,
  );
}
process.exit(1);
