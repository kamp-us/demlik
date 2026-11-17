import type { LoadedProject } from "../extract/project.js";
import type { Graph } from "../schema.js";
import { nodeField } from "../syntax/file.js";
import { closedClumps } from "./itemsets.js";
import { type CallShape, callShape, type PositionalClump, positionalClumps } from "./positional.js";
import { compareSites, type Site, scan } from "./scan.js";
import type { DuplicationSettings } from "./settings.js";
import { type ArgumentValue, argumentValues, referenceName } from "./values.js";

export type DataClump = { callee: string; values: string[]; siteCount: number; sites: Site[] };
export type RepeatedArgument = {
  callee: string;
  value: string;
  site: Site;
  arguments: { index: number; line: number; column: number }[];
};
type Call = { site: Site; values: ArgumentValue[]; shape: CallShape | null };
type Clump = DataClump | PositionalClump;

function repeatedAt(callee: string, call: Call): RepeatedArgument[] {
  const byValue = new Map<string, Map<number, ArgumentValue>>();
  for (const value of call.values) {
    const argumentsByIndex = byValue.get(value.value) ?? new Map<number, ArgumentValue>();
    if (!argumentsByIndex.has(value.index)) argumentsByIndex.set(value.index, value);
    byValue.set(value.value, argumentsByIndex);
  }
  return [...byValue.entries()]
    .filter(([, uses]) => uses.size > 1)
    .map(([value, uses]) => ({
      callee,
      value,
      site: call.site,
      arguments: [...uses.values()].map(({ index, line, column }) => ({ index, line, column })),
    }));
}

function collectCalls(loaded: LoadedProject, graph: Graph): Map<string, Call[]> {
  const calls = new Map<string, Call[]>();
  scan(loaded, graph, (unit) => (node, site) => {
    if (node.type !== "CallExpression" && node.type !== "NewExpression") return;
    const calleeNode = nodeField(node, "callee");
    const callee = calleeNode === null ? null : referenceName(calleeNode);
    if (callee === null) return;
    const group = calls.get(callee) ?? [];
    group.push({ site, values: argumentValues(unit, node), shape: callShape(node) });
    calls.set(callee, group);
  });
  return calls;
}

function clumpsFor(
  callee: string,
  group: readonly Call[],
  settings: DuplicationSettings,
): DataClump[] {
  const sets = group.map(
    (call) => new Set(call.values.filter((v) => v.kind === "name").map((v) => v.value)),
  );
  return closedClumps(sets, settings).map((clump) => {
    const sites = clump.sites.map((index) => group[index].site);
    return { callee, values: clump.values, siteCount: sites.length, sites };
  });
}

function compareClumps(a: Clump, b: Clump): number {
  const aValues = "values" in a ? a.values : a.slots;
  const bValues = "values" in b ? b.values : b.slots;
  return (
    b.siteCount - a.siteCount ||
    bValues.length - aValues.length ||
    a.callee.localeCompare(b.callee) ||
    aValues.join("\0").localeCompare(bValues.join("\0")) ||
    Number("slots" in a) - Number("slots" in b) ||
    compareSites(a.sites[0], b.sites[0])
  );
}

export function findDataClumps(
  loaded: LoadedProject,
  graph: Graph,
  settings: DuplicationSettings,
): { clumps: Clump[]; repeatedArguments: RepeatedArgument[] } {
  const clumps: Clump[] = [];
  const repeatedArguments: RepeatedArgument[] = [];
  for (const [callee, group] of collectCalls(loaded, graph)) {
    group.sort((a, b) => compareSites(a.site, b.site));
    for (const call of group) repeatedArguments.push(...repeatedAt(callee, call));
    clumps.push(
      ...clumpsFor(callee, group, settings),
      ...positionalClumps(callee, group, settings),
    );
  }
  clumps.sort(compareClumps);
  repeatedArguments.sort((a, b) => compareSites(a.site, b.site) || a.value.localeCompare(b.value));
  return { clumps, repeatedArguments };
}
