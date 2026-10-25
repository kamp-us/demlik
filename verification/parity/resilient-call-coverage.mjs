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
const inventoryFile = path.join(target, "resilient-call-inventory.json");
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
  await readFile(path.join(here, "resilient-call-contracts.json"), "utf8"),
);
const base = JSON.parse(
  await readFile(path.join(target, "report.json"), "utf8"),
);
const resilient = JSON.parse(
  await readFile(path.join(target, "resilient-call.json"), "utf8"),
);
assert.equal(base.reference, resilient.reference);
const evidence = new Map(
  Object.entries({ ...base.nativeEvidence, ...resilient.nativeEvidence }).map(
    ([id, paths]) => [id, new Set(paths)],
  ),
);
const gaps = [];
for (const [id, mapping] of Object.entries(mappings)) {
  if (
    inventory.capabilities.find((value) => value.id === id)?.signature !==
    mapping.signature
  )
    gaps.push({ id, reason: "TypeScript declaration changed" });
  await access(path.join(root, mapping.rust.file));
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
  path.join(target, "resilient-call-coverage.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
assert.deepEqual(gaps, []);
