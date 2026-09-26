import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const expected = {
  "@demlik/code-graph/project": [
    "listVisibleFiles",
    "listSourceFiles",
    "discoverPackageRoots",
    "resolveEdgeTsConfig",
    "toRelative",
    "findRepoRoot",
  ],
  "@demlik/code-graph/resolve": ["loadInProcessGraph"],
  "@demlik/code-graph/scc": ["stronglyConnectedComponents", "sccMembers"],
  "@demlik/code-graph/boundaries": [
    "boundaryLedgerOf",
    "ledgerKey",
    "ledgerTargetOf",
    "parseBoundaryLedger",
    "readBoundaryLedger",
    "serializeBoundaryLedger",
    "writeBoundaryLedger",
    "rekeyBoundaryLedger",
    "rekeyBoundaryLedgerFile",
  ],
};

// Removed from ./project in #397 with ts-morph: the loaders returned ts-morph's Project.
const removed = { "@demlik/code-graph/project": ["loadEdgeProject", "loadCheapProject"] };

const packageDir = path.dirname(createRequire(import.meta.url).resolve("../package.json"));
const exportMap = JSON.parse(
  fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
).exports;

function typesFileOf(specifier) {
  const entry = exportMap[`.${specifier.slice("@demlik/code-graph".length)}`];
  return typeof entry === "object" && entry.types ? path.join(packageDir, entry.types) : null;
}

const failures = [];
for (const [specifier, names] of Object.entries(expected)) {
  let mod;
  try {
    mod = await import(specifier);
  } catch (error) {
    failures.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  for (const name of names) {
    if (typeof mod[name] !== "function") failures.push(`${specifier}: no function export ${name}`);
  }
  for (const name of removed[specifier] ?? []) {
    if (name in mod) failures.push(`${specifier}: still exports ${name}`);
  }
  const types = typesFileOf(specifier);
  if (
    types !== null &&
    fs.existsSync(types) &&
    fs.readFileSync(types, "utf8").includes("ts-morph")
  ) {
    failures.push(`${specifier}: ${path.relative(packageDir, types)} names ts-morph`);
  }
}

if (failures.length > 0) {
  console.error(`verify-exports: ${failures.length} export check(s) failed:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`verify-exports: ${Object.keys(expected).length} subpaths import from dist`);
