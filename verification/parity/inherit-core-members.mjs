import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveContract } from "./coverage.mjs";

export function inheritCoreMembers(inventory, mappings) {
  const capabilities = new Map(
    inventory.capabilities.map((item) => [item.id, item]),
  );
  const next = { ...mappings };
  const added = [];
  for (const capability of capabilities.values()) {
    if (Object.hasOwn(next, capability.id)) continue;
    const origin = capability.id.match(
      /^(.*?):.*\/member:src\/[^#]+#([^:]+):([0-9a-f]{64})$/,
    );
    if (!origin) continue;
    const target = `${origin[1]}:.#${origin[2]}/member:published:${origin[3]}`;
    const candidate = {
      signature: capability.signature,
      inheritedFrom: target,
    };
    next[capability.id] = candidate;
    // The existing gate owns all source-owner, declaration and signature checks.
    const resolved = resolveContract(capability, next, capabilities);
    if (resolved.gaps.length) delete next[capability.id];
    else added.push({ id: capability.id, inheritedFrom: target });
  }
  return { mappings: next, added };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [inventoryFile, contractsFile] = process.argv.slice(2);
  assert.ok(inventoryFile && contractsFile && process.argv.length === 4);
  const inventory = JSON.parse(fs.readFileSync(inventoryFile, "utf8"));
  const mappings = JSON.parse(fs.readFileSync(contractsFile, "utf8"));
  const result = inheritCoreMembers(inventory, mappings);
  if (result.added.length)
    fs.writeFileSync(
      contractsFile,
      `${JSON.stringify(result.mappings, null, 2)}\n`,
    );
  console.log(
    JSON.stringify({
      addedReferences: result.added.length,
      ownedMappingsUnchanged: Object.keys(mappings).length,
      newImplementationOrComparisonCredit: 0,
    }),
  );
}
