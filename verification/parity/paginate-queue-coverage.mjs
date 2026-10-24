import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceGaps } from "./coverage.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);
const target = path.join(root, "target/parity");
await mkdir(target, { recursive: true });
const inventoryFile = path.join(target, "paginate-queue-inventory.json");
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
const contracts = JSON.parse(
  await readFile(path.join(here, "paginate-queue-contracts.json"), "utf8"),
);
const base = JSON.parse(
  await readFile(path.join(target, "report.json"), "utf8"),
);
const current = JSON.parse(
  await readFile(path.join(target, "paginate-queue.json"), "utf8"),
);
assert.equal(base.reference, current.reference);
const evidence = new Map(
  Object.entries({ ...base.nativeEvidence, ...current.nativeEvidence }).map(
    ([id, paths]) => [id, new Set(paths)],
  ),
);
const gaps = [];
for (const [id, mapping] of Object.entries(contracts)) {
  const actual = inventory.capabilities.find((cap) => cap.id === id);
  if (actual?.signature !== mapping.signature)
    gaps.push({ id, reason: "TypeScript declaration changed" });
  for (const reason of evidenceGaps(mapping, evidence))
    gaps.push({ id, reason });
}
const report = {
  scope:
    "L1 paginator, pure queue and sequential store adapter; composed walk and resolved-await scheduling remain open",
  mappings: Object.keys(contracts).length,
  owned: Object.values(contracts).filter((mapping) => !mapping.canonical)
    .length,
  sharedStoreAliases: Object.values(contracts).filter(
    (mapping) => mapping.canonical,
  ).length,
  gaps,
  warnings: inventory.warnings,
};
await writeFile(
  path.join(target, "paginate-queue-coverage.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
assert.deepEqual(gaps, []);
