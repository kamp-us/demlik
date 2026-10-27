import { execFileSync } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
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

export function resolveContract(capability, mappings, capabilities) {
  const mapping = mappings[capability.id];
  if (!mapping || !Object.hasOwn(mapping, "inheritedFrom"))
    return { mapping, gaps: [] };
  const origin = capability.id.match(
    /^(.*?):.*\/member:src\/[^#]+#([^:]+):([0-9a-f]{64})$/,
  );
  const target = origin
    ? `${origin[1]}:.#${origin[2]}/member:published:${origin[3]}`
    : undefined;
  if (!target || mapping.inheritedFrom !== target)
    return {
      gaps: ["Canonical mapping does not match the source member owner"],
    };
  const owner = mappings[target],
    declaration = capabilities.get(target);
  if (!owner || Object.hasOwn(owner, "inheritedFrom") || !declaration)
    return { gaps: ["Canonical source member has no owned mapping"] };
  if (
    mapping.signature !== capability.signature ||
    owner.signature !== declaration.signature ||
    declaration.signature !== capability.signature ||
    declaration.declaration !== capability.declaration
  )
    return { gaps: ["Canonical source declaration changed"] };
  return {
    mapping: mapping.knownGaps?.length
      ? {
          ...owner,
          knownGaps: [...(owner.knownGaps ?? []), ...mapping.knownGaps],
        }
      : owner,
    gaps: [],
  };
}

export async function discoverCoverageInventory() {
  const file = path.join(root, "target/parity/inventory.json");
  await mkdir(path.dirname(file), { recursive: true });
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
  return JSON.parse(await readFile(file, "utf8"));
}

export async function checkCoverage(evidence, inventory) {
  const mappings = JSON.parse(
    await readFile(path.join(here, "contracts.json"), "utf8"),
  );
  const gaps = [];
  const capabilities = new Map(
    inventory.capabilities.map((item) => [item.id, item]),
  );
  for (const capability of inventory.capabilities) {
    const resolved = resolveContract(capability, mappings, capabilities);
    if (resolved.gaps.length) {
      for (const reason of resolved.gaps)
        gaps.push({ id: capability.id, reason });
      continue;
    }
    const mapping = resolved.mapping;
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
    inheritedMemberReferences: Object.values(mappings).filter((item) =>
      Object.hasOwn(item, "inheritedFrom"),
    ).length,
    gaps,
    warnings: inventory.warnings,
  };
}
