import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);

export async function checkCoverage(verifiedCases) {
  const file = path.join(root, "target/parity/inventory.json");
  execFileSync(
    process.execPath,
    [
      "--import",
      require.resolve("tsx"),
      path.join(here, "inventory.mts"),
      file,
    ],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  const inventory = JSON.parse(await readFile(file, "utf8"));
  const mappings = JSON.parse(
    await readFile(path.join(here, "contracts.json"), "utf8"),
  );
  const gaps = [];
  for (const capability of inventory.capabilities) {
    const mapping = mappings[capability.id];
    if (!mapping) {
      gaps.push({
        id: capability.id,
        reason: "Rust mapping and verification missing",
      });
      continue;
    }
    if (mapping.signature !== capability.signature)
      gaps.push({
        id: capability.id,
        reason: "TypeScript declaration changed",
      });
    if (
      !mapping.cases?.length ||
      !mapping.cases.every((id) => verifiedCases.has(id))
    ) {
      gaps.push({
        id: capability.id,
        reason: "Verification absent or failing",
      });
    }
    if (!mapping.rust?.file || !mapping.rust?.symbol)
      gaps.push({ id: capability.id, reason: "Rust API absent" });
    else await access(path.join(root, mapping.rust.file));
  }
  for (const id of Object.keys(mappings)) {
    if (!inventory.capabilities.some((capability) => capability.id === id))
      gaps.push({ id, reason: "Stale capability mapping" });
  }
  return {
    total: inventory.capabilities.length,
    mapped: Object.keys(mappings).length,
    gaps,
    warnings: inventory.warnings,
  };
}
