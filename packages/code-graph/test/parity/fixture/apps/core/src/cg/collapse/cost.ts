import { invokedAdjacency } from "../query/reach.js";
import type { FunctionNode } from "../schema.js";
import type { CollapseSettings } from "./settings.js";
import { round4, type Twin } from "./signals.js";

export type CostInputs = {
  callerUnion: number;
  packagesSpanned: number;
  crossesPackage: boolean;
  effectOnPath: boolean;
};

export type CostContext = {
  packageOf: (file: string) => string;
  fileOf: ReadonlyMap<string, string>;
  reachesEffect: ReadonlySet<string>;
};

export function packageResolver(packageRoots: readonly string[]): (file: string) => string {
  const sorted = [...packageRoots].sort((a, b) => b.length - a.length);
  return (file: string): string => {
    for (const root of sorted) {
      if (root === "") return "";
      if (file === root || file.startsWith(`${root}/`)) return root;
    }
    return "";
  };
}

export function effectReachers(functions: readonly FunctionNode[]): Set<string> {
  const forward = invokedAdjacency(functions);
  const reverse = new Map<string, string[]>();
  for (const [from, tos] of forward) {
    for (const to of tos) {
      const bucket = reverse.get(to);
      if (bucket === undefined) reverse.set(to, [from]);
      else bucket.push(from);
    }
  }
  const seen = new Set<string>(
    functions.filter((f) => f.nodeKind?.kind === "effect").map((f) => f.id),
  );
  const queue = [...seen];
  let i = 0;
  while (i < queue.length) {
    const id = queue[i++];
    if (id === undefined) continue;
    for (const prev of reverse.get(id) ?? []) {
      if (seen.has(prev)) continue;
      seen.add(prev);
      queue.push(prev);
    }
  }
  return seen;
}

export function costInputs(a: Twin, b: Twin, ctx: CostContext): CostInputs {
  const callers = new Set<string>([...a.callers, ...b.callers]);
  const packages = new Set<string>([ctx.packageOf(a.file), ctx.packageOf(b.file)]);
  for (const caller of callers) {
    const file = ctx.fileOf.get(caller);
    if (file !== undefined) packages.add(ctx.packageOf(file));
  }
  return {
    callerUnion: callers.size,
    packagesSpanned: packages.size,
    crossesPackage: ctx.packageOf(a.file) !== ctx.packageOf(b.file),
    effectOnPath: ctx.reachesEffect.has(a.id) || ctx.reachesEffect.has(b.id),
  };
}

export function collapseCost(inputs: CostInputs, s: CollapseSettings): number {
  const cost =
    1 +
    s.costCallerWeight * Math.log2(1 + inputs.callerUnion) +
    s.costPackageWeight * Math.max(0, inputs.packagesSpanned - 1) +
    (inputs.crossesPackage ? s.costCrossPackageWeight : 0) +
    (inputs.effectOnPath ? s.costEffectWeight : 0);
  return round4(cost);
}
