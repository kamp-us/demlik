import { memoryArtifactStore, runStage } from "../src/lowering/artifact.js";
import type { Fact } from "../src/lowering/fact.js";
import {
  type Atom,
  type GraphFunction,
  type LoweredBranch,
  loweringInput,
  lowerStage,
  renderAtom,
  renderOutcome,
} from "../src/lowering/lower.js";

/**
 * The graph nodes code-graph would report for every top-level `export function` in `source`: a
 * synthetic stand-in for a `--graph` JSON file, so a fixture needs no code-graph run. A function
 * ends on the first line after its start that is a lone `}`.
 */
export function graphOf(
  file: string,
  source: string,
  calls: Readonly<
    Record<string, readonly { calleeId: string; line: number }[]>
  > = {},
): GraphFunction[] {
  const lines = source.split("\n");
  const out: GraphFunction[] = [];
  lines.forEach((line, i) => {
    const name = /^export (?:async )?function (\w+)/.exec(line)?.[1];
    if (name === undefined) return;
    const end = lines.findIndex((l, j) => j >= i && l === "}");
    const id = `${file}:${name}`;
    out.push({
      id,
      file,
      startLine: i + 1,
      endLine: end + 1,
      edges: { calls: [...(calls[name] ?? [])] },
    });
  });
  return out;
}

/** The line a snippet is on, 1-based, so a fixture names a call site without counting by hand. */
export const lineOf = (source: string, snippet: string): number =>
  source.slice(0, source.indexOf(snippet)).split("\n").length;

export async function lower(
  file: string,
  source: string,
  options: {
    readonly loggingRoots?: readonly string[];
    readonly functions?: readonly GraphFunction[];
  } = {},
): Promise<readonly Fact<LoweredBranch>[]> {
  const run = await runStage(
    memoryArtifactStore<LoweredBranch>(),
    lowerStage,
    loweringInput({
      file,
      source,
      functions: options.functions ?? graphOf(file, source),
      ...(options.loggingRoots === undefined
        ? {}
        : { loggingRoots: options.loggingRoots }),
    }),
  );
  return run.artifact.facts;
}

export function known(fact: Fact<LoweredBranch> | undefined): LoweredBranch {
  if (fact?.value._tag !== "known")
    throw new Error(`expected a lowered branch, got ${JSON.stringify(fact)}`);
  return fact.value.value;
}

/** A branch as text: its path's atoms, then its outcome. */
export const shape = (branch: LoweredBranch) => ({
  path: branch.path.map(renderAtom),
  outcome: renderOutcome(branch.outcome),
});

/** A value with every `span` and the function id removed: what two renamed functions share. */
export function withoutSpans(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSpans);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "span" && key !== "function")
        .map(([key, v]) => [key, withoutSpans(v)]),
    );
  return value;
}

export const atomsOf = (branch: LoweredBranch): readonly Atom[] =>
  branch.path.flatMap((atom) =>
    atom.kind === "any" ? [atom, ...atom.disjuncts.flat()] : [atom],
  );
