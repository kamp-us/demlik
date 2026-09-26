import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import type { z } from "zod";
import { DEFAULTS, underRoot } from "../cli-paths.js";
import { git, repoRootOf } from "../git.js";
import { GroupsFile } from "../groups/file.js";
import { buildInventory, type InventoryInputs } from "./build.js";
import {
  ConsolidateInput,
  GraphInput,
  INPUT_FLAGS,
  PairsInput,
  readSource,
  UnreachableInput,
} from "./inputs.js";
import { SAME_DECISION_FLOOR, SHARED_HELPER_FLOOR } from "./levers.js";
import { renderInventory } from "./render.js";

export const INVENTORY_USAGE = `structure-sweep inventory [options]

  Join outputs already on disk into one consolidation list, ordered by lever and then by
  deletions, biggest first: A dead exports, B tiny-file merges, C same decision (pairs at
  >= ${SAME_DECISION_FLOOR}), D shared helper (pairs at >= ${SHARED_HELPER_FLOOR}), E exported-name twins, F rule groups.
  A missing input skips its levers and says so. Runs no other command; no Jev call, no network.

  --unreachable <file>  code-graph --unreachable --json output (lever A; none by default)
  --graph <file>        code-graph --graph JSON (lever E, and A's end lines; none by default)
  --consolidate <file>  consolidate output (lever B; default: ${DEFAULTS.consolidate})
  --pairs <file>        pairs output (levers C and D; default: ${DEFAULTS.pairs})
  --groups <file>       stage 6 to 8 groups file (lever F; default: ${DEFAULTS.groups})
  --exclude <glob>      keep matching files out of lever B (repeatable)
  --out <file>          JSON inventory (default: ${DEFAULTS.inventory})
  --report <file>       markdown inventory (default: ${DEFAULTS.inventoryReport})`;

/** A file's line count as `ref` has it, or `undefined` when git cannot show it there. */
function linesAt(root: string, ref: string) {
  return (path: string): number | undefined => {
    try {
      const text = git(root, ["show", `${ref}:${path}`]);
      return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    } catch {
      return undefined;
    }
  };
}

export function inventoryCommand(argv: readonly string[], cwd: string): void {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      unreachable: { type: "string" },
      graph: { type: "string" },
      consolidate: { type: "string", default: DEFAULTS.consolidate },
      pairs: { type: "string", default: DEFAULTS.pairs },
      groups: { type: "string", default: DEFAULTS.groups },
      exclude: { type: "string", multiple: true, default: [] },
      out: { type: "string", default: DEFAULTS.inventory },
      report: { type: "string", default: DEFAULTS.inventoryReport },
    },
  });
  const root = repoRootOf(cwd);
  const resolve = (path: string) => underRoot(root, path);
  const read = <T>(
    name: keyof typeof INPUT_FLAGS,
    path: string | undefined,
    schema: z.ZodType<T>,
  ) => readSource({ flag: INPUT_FLAGS[name], path }, resolve, schema);

  const inputs: InventoryInputs = {
    unreachable: read("unreachable", values.unreachable, UnreachableInput),
    graph: read("graph", values.graph, GraphInput),
    consolidate: read("consolidate", values.consolidate, ConsolidateInput),
    pairs: read("pairs", values.pairs, PairsInput),
    groups: read("groups", values.groups, GroupsFile),
  };
  const inventory = buildInventory(inputs, {
    exclude: values.exclude,
    fileLines:
      inputs.consolidate._tag === "read"
        ? linesAt(root, inputs.consolidate.value.ref)
        : undefined,
  });

  const outPath = resolve(values.out);
  const reportPath = resolve(values.report);
  for (const path of [outPath, reportPath])
    mkdirSync(dirname(path), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(inventory, null, 1)}\n`);
  writeFileSync(reportPath, renderInventory(inventory));
  for (const lever of inventory.levers)
    console.error(
      lever.state === "built"
        ? `${lever.lever}: ${lever.entries} entries`
        : `${lever.lever}: skipped, ${lever.path ?? lever.flag} ${lever.reason}`,
    );
  console.error(
    `${inventory.entries.length} entries → ${outPath}, ${reportPath}`,
  );
}
