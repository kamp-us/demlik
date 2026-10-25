import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceGaps } from "./coverage.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)),
  root = path.resolve(here, "../..");
const require = createRequire(import.meta.url),
  target = path.join(root, "target/parity");
const inventoryFile = path.join(target, "reconciler-inventory.json");
execFileSync(
  process.execPath,
  [
    "--import",
    require.resolve("tsx"),
    path.join(here, "inventory.mts"),
    inventoryFile,
  ],
  { cwd: root, stdio: "inherit" },
);
const inventory = JSON.parse(await readFile(inventoryFile, "utf8"));
const mappings = JSON.parse(
  await readFile(path.join(here, "reconciler-contracts.json"), "utf8"),
);
const base = JSON.parse(
  await readFile(path.join(target, "report.json"), "utf8"),
);
const reconciler = JSON.parse(
  await readFile(path.join(target, "reconciler.json"), "utf8"),
);
assert.equal(base.reference, reconciler.reference);
assert.equal(reconciler.passed, reconciler.cases);
const evidence = new Map(
  Object.entries({ ...base.nativeEvidence, ...reconciler.nativeEvidence }).map(
    ([id, calls]) => [id, new Set(calls)],
  ),
);
const ownedInventory = inventory.capabilities.filter(
  (value) =>
    value.id.startsWith("@demlik/tea:./flow#") &&
    ["Reconciler", "ReconcilePhase", "ScanPage"].some((name) =>
      value.id.split("/member:")[0].includes(name),
    ),
);
assert.deepEqual(
  Object.keys(mappings).sort(),
  ownedInventory.map((value) => value.id).sort(),
);
const canonicalOwners = {
  ...JSON.parse(await readFile(path.join(here, "contracts.json"), "utf8")),
  ...JSON.parse(
    await readFile(path.join(here, "paginated-walk-contracts.json"), "utf8"),
  ),
  ...mappings,
};
const gaps = [];
for (const [id, mapping] of Object.entries(mappings)) {
  if (
    inventory.capabilities.find((value) => value.id === id)?.signature !==
    mapping.signature
  )
    gaps.push({ id, reason: "TypeScript declaration changed" });
  await access(path.join(root, mapping.rust.file));
  if (mapping.canonical && !canonicalOwners[mapping.canonical])
    gaps.push({ id, reason: "Canonical owner is absent" });
  for (const reason of evidenceGaps(mapping, evidence))
    gaps.push({ id, reason });
}
const report = {
  mappings: Object.keys(mappings).length,
  owned: Object.values(mappings).filter((value) => !value.canonical).length,
  sharedAliases: Object.values(mappings).filter((value) => value.canonical)
    .length,
  knownQualifications: Object.entries(mappings)
    .filter(([, value]) => value.knownGaps)
    .map(([id, value]) => ({ id, knownGaps: value.knownGaps })),
  gaps,
  warnings: inventory.warnings,
};
await writeFile(
  path.join(target, "reconciler-coverage.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
assert.deepEqual(gaps, []);
