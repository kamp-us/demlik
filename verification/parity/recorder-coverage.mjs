import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evidenceGaps } from "./coverage.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)),
  root = path.resolve(here, "../.."),
  require = createRequire(import.meta.url),
  target = path.join(root, "target/parity"),
  inventoryFile = path.join(target, "recorder-inventory.json");
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
const inventory = JSON.parse(await readFile(inventoryFile, "utf8")),
  names = new Set([
    "Trace",
    "RecorderOptions",
    "Recorder",
    "recorder",
    "parseJSONL",
    "TraceAttachment",
    "traceAttachment",
    "TraceBreadcrumb",
    "BreadcrumbsOptions",
    "breadcrumbsFromTrace",
    "ReplayResult",
    "replayTrace",
    "deepEqual",
  ]),
  capabilities = inventory.capabilities.filter(
    (item) =>
      item.id.startsWith("@demlik/tea:./persistence#") &&
      names.has(item.id.split("#")[1].split("/member:")[0]),
  ),
  owned = capabilities.filter((item) => !item.id.includes("/member:src")),
  inherited = capabilities.filter((item) => item.id.includes("/member:src")),
  mappings = JSON.parse(
    await readFile(path.join(here, "recorder-contracts.json"), "utf8"),
  ),
  inheritedFile = JSON.parse(
    await readFile(path.join(here, "recorder-inherited.json"), "utf8"),
  ),
  shared = JSON.parse(
    await readFile(path.join(target, "recorder.json"), "utf8"),
  ),
  runtime = JSON.parse(
    await readFile(path.join(target, "recorder-runtime.json"), "utf8"),
  ),
  evidence = new Map(
    Object.entries({ ...shared.nativeEvidence, ...runtime.nativeEvidence }).map(
      ([id, calls]) => [id, new Set(calls)],
    ),
  );
assert.equal(shared.passed, shared.cases);
assert.equal(runtime.passed, runtime.cases);
assert.deepEqual(
  Object.keys(mappings).sort(),
  owned.map((item) => item.id).sort(),
);
assert.deepEqual(inheritedFile, inherited);
const gaps = [];
for (const item of owned) {
  const mapping = mappings[item.id];
  if (mapping.signature !== item.signature)
    gaps.push({ id: item.id, reason: "Source signature changed" });
  await access(path.join(root, mapping.rust.file));
  for (const reason of evidenceGaps(mapping, evidence))
    gaps.push({ id: item.id, reason });
}
const report = {
  scope:
    "Recorder-owned exports/callables only; referenced Runtime/core capabilities stay with their canonical owners",
  reference: shared.reference,
  ownedMappings: owned.length,
  inheritedCanonicalIntegrationEntries: inherited.length,
  inheritedFile: "verification/parity/recorder-inherited.json",
  gaps,
  warnings: inventory.warnings,
  qualifications: [
    "The inherited entries are enumerated for central canonical-owner integration, not fabricated as recorder mappings or counted as completed here.",
    "The shared Tagged::tag owner remains UTF-8. Default breadcrumb tag text uses it; explicit renderers and JSON codecs retain arbitrary JsText payloads/keys. Shared tag migration remains an overall-port qualification.",
    "Backend JSON diagnostics preserve real serde/V8 causes separately; the source-owned refusal prefix/name/line, accept/reject behavior and values are strict.",
  ],
};
await writeFile(
  path.join(target, "recorder-coverage.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
assert.deepEqual(gaps, []);
