import { readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { z } from "zod";

const NodeKind = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entry"), evidence: z.array(z.string()) }),
  z.object({ kind: z.literal("auth"), evidence: z.array(z.string()) }),
  z.object({ kind: z.literal("effect"), evidence: z.array(z.string()) }),
  z.object({ kind: z.literal("plain") }),
]);

const GraphFile = z.object({
  root: z.string(),
  functions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      file: z.string(),
      isTest: z.boolean(),
      edges: z
        .object({
          calls: z.array(z.object({ calleeId: z.string() })),
          calledBy: z.array(z.object({ callerId: z.string() })),
        })
        .nullable(),
      nodeKind: NodeKind.nullable(),
    }),
  ),
  crossRuntime: z
    .object({
      edges: z.array(
        z.object({
          callerId: z.string(),
          targetService: z.string(),
          method: z.string(),
        }),
      ),
    })
    .nullable(),
});

export type GraphFacts = {
  readonly calledFromFiles: readonly string[];
  readonly callsFiles: readonly string[];
  readonly callsLibraries: readonly string[];
  readonly entryPoints: readonly string[];
  readonly authChecks: readonly string[];
  readonly sideEffects: readonly string[];
  readonly callsOtherWorkers: readonly string[];
};

const LIST_LIMIT = 12;

const BUILTINS = new Set(
  "map filter reduce forEach push pop shift unshift slice splice concat join split trim some every find findIndex includes indexOf keys values entries assign freeze from of parse stringify then catch finally resolve reject all allSettled get set has delete add clear toString toISOString getTime now floor ceil round max min abs startsWith endsWith replace replaceAll match test exec toLowerCase toUpperCase padStart padEnd sort reverse flat flatMap fill at log error warn info debug String Number Boolean Array Object Date Map Set Promise Error JSON Math isArray isNaN parseInt parseFixed length size Symbol iterator next return throw describe string number boolean optional nullable nullish object array enum literal union discriminatedUnion int min nonnegative positive default safeParse transform refine infer".split(
    " ",
  ),
);

function top(counts: Map<string, number>): string[] {
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, LIST_LIMIT)
    .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

const fileOf = (id: string) => id.slice(0, id.lastIndexOf(":"));

type GraphFunction = z.infer<typeof GraphFile>["functions"][number];
type Graph = z.infer<typeof GraphFile>;

function functionsByFile(graph: Graph): Map<string, GraphFunction[]> {
  const perFile = new Map<string, GraphFunction[]>();
  for (const fn of graph.functions) {
    if (fn.isTest) continue;
    const list = perFile.get(fn.file) ?? [];
    list.push(fn);
    perFile.set(fn.file, list);
  }
  return perFile;
}

function workerCallsByFile(graph: Graph): Map<string, Map<string, number>> {
  const workerCalls = new Map<string, Map<string, number>>();
  for (const edge of graph.crossRuntime?.edges ?? []) {
    const file = fileOf(edge.callerId);
    const counts = workerCalls.get(file) ?? new Map<string, number>();
    bump(counts, `${edge.targetService}.${edge.method}`);
    workerCalls.set(file, counts);
  }
  return workerCalls;
}

function countCallers(
  file: string,
  fns: readonly GraphFunction[],
): Map<string, number> {
  const calledFrom = new Map<string, number>();
  for (const fn of fns) {
    for (const { callerId } of fn.edges?.calledBy ?? []) {
      const from = fileOf(callerId);
      if (from !== file && !/\.(test|spec)\./.test(from))
        bump(calledFrom, basename(from));
    }
  }
  return calledFrom;
}

function countCallees(
  file: string,
  fns: readonly GraphFunction[],
): { calls: Map<string, number>; libs: Map<string, number> } {
  const calls = new Map<string, number>();
  const libs = new Map<string, number>();
  for (const { calleeId } of fns.flatMap((fn) => fn.edges?.calls ?? [])) {
    if (calleeId.startsWith("external:")) {
      const name = calleeId.slice("external:".length);
      if (!BUILTINS.has(name)) bump(libs, name);
    } else if (fileOf(calleeId) !== file) {
      bump(calls, basename(fileOf(calleeId)));
    }
  }
  return { calls, libs };
}

function kindsOf(
  fns: readonly GraphFunction[],
  kind: "entry" | "auth" | "effect",
): string[] {
  return fns
    .flatMap((fn) =>
      fn.nodeKind?.kind === kind
        ? [`${fn.name} (${fn.nodeKind.evidence.join(", ")})`]
        : [],
    )
    .slice(0, LIST_LIMIT);
}

function factsForFile(
  file: string,
  fns: readonly GraphFunction[],
  workerCalls: ReadonlyMap<string, Map<string, number>>,
): GraphFacts {
  const { calls, libs } = countCallees(file, fns);
  return {
    calledFromFiles: top(countCallers(file, fns)),
    callsFiles: top(calls),
    callsLibraries: top(libs),
    entryPoints: kindsOf(fns, "entry"),
    authChecks: kindsOf(fns, "auth"),
    sideEffects: kindsOf(fns, "effect"),
    callsOtherWorkers: top(workerCalls.get(file) ?? new Map()),
  };
}

export function loadGraphFacts(
  repoRoot: string,
  graphPaths: readonly string[],
): Map<string, GraphFacts> {
  const out = new Map<string, GraphFacts>();
  for (const graphPath of graphPaths) {
    const graph = GraphFile.parse(JSON.parse(readFileSync(graphPath, "utf8")));
    const rootAbs = isAbsolute(graph.root)
      ? graph.root
      : join(repoRoot, graph.root);
    const workerCalls = workerCallsByFile(graph);
    for (const [file, fns] of functionsByFile(graph)) {
      out.set(
        relative(repoRoot, join(rootAbs, file)),
        factsForFile(file, fns, workerCalls),
      );
    }
  }
  return out;
}
