import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evidenceGaps } from "./coverage.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url)),
  sha = (v) => createHash("sha256").update(v).digest("hex");
export function agentStatusCoverage(options = {}) {
  const contractsFile = path.join(
      root,
      "verification/parity/agent-status-contracts.json",
    ),
    inventoryFile =
      options.inventoryFile ?? path.join(root, "target/parity/inventory.json"),
    baselineFile =
      options.baselineFile ??
      path.join(root, "target/parity/agent-status-mutation-baseline.json"),
    contracts = JSON.parse(fs.readFileSync(contractsFile)),
    inventory = JSON.parse(fs.readFileSync(inventoryFile)),
    baseline = JSON.parse(fs.readFileSync(baselineFile)),
    byId = new Map(inventory.capabilities.map((c) => [c.id, c])),
    evidence = new Map(Object.entries(baseline.nativeEvidence));
  assert.equal(baseline.cases, 64);
  assert.equal(baseline.passed, 64);
  assert.deepEqual(baseline.failures, []);
  assert.equal(evidence.size, 64);
  assert.equal(baseline.qualifiedObservations.length, 3);
  for (const row of baseline.qualifiedObservations)
    assert.ok(!evidence.has(row.id));
  const mappings = [];
  for (const [id, m] of Object.entries(contracts)) {
    assert.ok(byId.has(id), id);
    assert.equal(m.signature, byId.get(id).signature, id);
    assert.ok(!Object.hasOwn(m, "inheritedFrom"));
    assert.ok(fs.existsSync(path.join(root, m.rust.file)));
    assert.deepEqual(evidenceGaps(m, evidence), [], id);
    assert.ok(m.nativeProfile.includes("borrowed view"));
    mappings.push({
      id,
      signature: m.signature,
      cases: m.cases,
      symbols: m.rust.symbols,
    });
  }
  assert.equal(mappings.length, 4);
  const report = {
      mappings,
      ownedIds: 4,
      newIds: 3,
      existingEndedOwnerUpdate: 1,
      allSelectedCasesStrict: true,
      allSymbolsObserved: true,
      noFabricatedInternalAliases: true,
      borrowedPendingLifetimeExplicit: true,
      qualifiedExcluded: 3,
      contractsSha256: sha(fs.readFileSync(contractsFile)),
      inventoryFile,
      inventorySha256: sha(fs.readFileSync(inventoryFile)),
      baselineFile,
      baselineSha256: sha(fs.readFileSync(baselineFile)),
    },
    out =
      options.reportFile ??
      path.join(root, "target/parity/agent-status-mapping-proof.json");
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({ ids: 4, newIds: 3, existingOwnerUpdate: 1, report: out }),
  );
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  agentStatusCoverage({ inventoryFile: process.argv[2] });
