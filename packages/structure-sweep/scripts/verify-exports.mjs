// Import every export-map subpath from dist, the way an installer resolves it, and check the names
// the README documents are there. Run after `pnpm build`.
import { accessSync, constants } from "node:fs";

const expected = {
  "@demlik/structure-sweep": [
    "runSweep",
    "runPairs",
    "planManifest",
    "planScope",
    "applyManifest",
    "applyMoves",
    "entryFiles",
    "loadVocabulary",
    "parseVocabulary",
    "httpJevClient",
    "scoreCoChange",
    "readChangeSets",
    "renderScoreTable",
    "mergeProposals",
    "extractProposals",
    "renderConsolidation",
    "runStage",
    "memoryArtifactStore",
    "evaluate",
    "loadGoldSet",
    "calibrate",
    "gate",
    "gateAll",
    "gatePolicy",
    "loweringInput",
    "lowerFile",
    "readLoweringGraph",
    "renderAtom",
    "parseLexicon",
    "loadLexicon",
    "resolveInput",
    "proposeLexicon",
    "writeLexiconDraft",
    "summarize",
    "resolveReturns",
    "renderReturnFact",
  ],
};

const failures = [];
for (const [specifier, names] of Object.entries(expected)) {
  let mod;
  try {
    mod = await import(specifier);
  } catch (error) {
    failures.push(
      `${specifier}: ${error instanceof Error ? error.message : String(error)}`,
    );
    continue;
  }
  for (const name of names) {
    if (typeof mod[name] !== "function")
      failures.push(`${specifier}: no function export ${name}`);
  }
}

try {
  accessSync(new URL("../dist/bin.js", import.meta.url), constants.X_OK);
} catch {
  failures.push("bin: dist/bin.js is missing or not executable");
}

if (failures.length > 0) {
  console.error(`verify-exports: ${failures.length} export check(s) failed:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `verify-exports: ${Object.keys(expected).length} subpath(s) and the bin resolve from dist`,
);
