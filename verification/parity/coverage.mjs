import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(import.meta.url);

export function evidenceGaps(mapping, evidence) {
  const symbols = mapping.rust?.symbols ?? [];
  if (
    !symbols.length ||
    symbols.some((symbol) => typeof symbol !== "string" || !symbol.length)
  )
    return ["Rust public API paths missing"];
  if (!mapping.cases?.length) return ["Verification absent"];
  const normalize = (symbol) => symbol.replace(/\s+/g, "");
  const observed = (id) =>
    new Set([...(evidence.get(id) ?? [])].map(normalize));
  const gaps = (mapping.knownGaps ?? []).map(
    (gap) => `Known parity gap: ${gap}`,
  );
  for (const symbol of symbols) {
    if (!mapping.cases.some((id) => observed(id).has(normalize(symbol))))
      gaps.push(`No passing compiled consumer called ${symbol}`);
  }
  for (const id of mapping.cases) {
    if (!symbols.some((symbol) => observed(id).has(normalize(symbol))))
      gaps.push(`Case ${id} did not call this capability`);
  }
  return gaps;
}

export async function checkCoverage(evidence) {
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
    for (const reason of evidenceGaps(mapping, evidence))
      gaps.push({ id: capability.id, reason });
    if (!mapping.rust?.file)
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
