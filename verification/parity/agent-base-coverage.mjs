import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evidenceGaps } from "./coverage.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Validate only these owned proposals against the canonical generated inventory. */
export function agentBaseCoverage(options = {}) {
  const file = (name) => path.join(root, name),
    contractsFile = file("verification/parity/agent-base-contracts.json"),
    inventoryFile =
      options.inventoryFile ?? file("target/parity/inventory.json"),
    baselineFile =
      options.baselineFile ??
      file("target/parity/agent-base-mutation-baseline.json"),
    contracts = JSON.parse(fs.readFileSync(contractsFile)),
    inventory = JSON.parse(fs.readFileSync(inventoryFile)),
    baseline = JSON.parse(fs.readFileSync(baselineFile)),
    capabilities = new Map(inventory.capabilities.map((c) => [c.id, c])),
    evidence = new Map(Object.entries(baseline.nativeEvidence));
  assert.equal(baseline.cases, 43);
  assert.equal(baseline.passed, 43);
  assert.deepEqual(baseline.failures, []);
  assert.equal(evidence.size, 43);
  for (const row of baseline.qualifiedObservations)
    assert.ok(!evidence.has(row.id));
  const mappings = [];
  for (const [id, contract] of Object.entries(contracts)) {
    const actual = capabilities.get(id);
    assert.ok(actual, `${id}: absent from canonical inventory`);
    assert.equal(contract.signature, actual.signature, id);
    assert.ok(!Object.hasOwn(contract, "inheritedFrom"));
    assert.ok(fs.existsSync(file(contract.rust.file)));
    const diagnostics = evidenceGaps(contract, evidence),
      allowed = (contract.knownGaps ?? []).map((g) => `Known parity gap: ${g}`);
    assert.deepEqual(diagnostics, allowed, id);
    mappings.push({
      id,
      signature: actual.signature,
      cases: contract.cases,
      symbols: contract.rust.symbols,
      knownGaps: contract.knownGaps ?? [],
    });
  }
  assert.equal(mappings.length, 14);
  const report = {
      mappings,
      proposals: mappings.length,
      completeWithinDeclaredProfile: mappings.filter(
        (m) => m.knownGaps.length === 0,
      ).length,
      partialOpen: mappings.filter((m) => m.knownGaps.length > 0).length,
      allSelectedCasesStrict: true,
      allSymbolsObserved: true,
      noFabricatedInternalAliases: true,
      contractsSha256: hash(fs.readFileSync(contractsFile)),
      inventoryFile,
      inventorySha256: hash(fs.readFileSync(inventoryFile)),
      baselineFile,
      baselineSha256: hash(fs.readFileSync(baselineFile)),
    },
    out =
      options.reportFile ?? file("target/parity/agent-base-mapping-proof.json");
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      proposals: report.proposals,
      completeWithinDeclaredProfile: report.completeWithinDeclaredProfile,
      partialOpen: report.partialOpen,
      report: out,
    }),
  );
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  agentBaseCoverage({ inventoryFile: process.argv[2] });
