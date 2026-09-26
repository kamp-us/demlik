import { embeddingText } from "../lowering/embed.js";
import {
  DEFAULT_LOGGING_ROOTS,
  type GraphFunction,
  type LoweringGraph,
  lowerFile,
} from "../lowering/lower.js";

/**
 * A code-graph function's lowered body: its stage-2 branches, each rendered as `embeddingText`
 * renders it, one paragraph per branch. Neutral names stand for its locals and parameters, so the
 * function's own name and its source are not in it.
 *
 * `undefined` when the graph has no node for the id, or stage 2 wrote no fact for the function or
 * left one `unknown`: that side is sent as its raw source instead. Each file is lowered once, in
 * process, with no Jev call.
 */
export function loweredBodies(
  graph: LoweringGraph,
  sourceOf: (file: string) => string,
): (id: string) => string | undefined {
  const nodes = new Map(graph.functions.map((fn) => [fn.id, fn]));
  const byFile = new Map<string, GraphFunction[]>();
  for (const fn of graph.functions)
    byFile.set(fn.file, [...(byFile.get(fn.file) ?? []), fn]);
  const lowered = new Map<string, ReadonlyMap<string, string | undefined>>();
  const lowerOnce = (file: string) => {
    const done = lowered.get(file);
    if (done !== undefined) return done;
    const branches = new Map<string, string[]>();
    const unknown = new Set<string>();
    const facts = lowerFile({
      file,
      source: sourceOf(file),
      functions: byFile.get(file) ?? [],
      loggingRoots: [...DEFAULT_LOGGING_ROOTS],
    });
    for (const fact of facts) {
      if (fact.value._tag === "unknown") {
        unknown.add(fact.id);
        continue;
      }
      const branch = fact.value.value;
      branches.set(branch.function, [
        ...(branches.get(branch.function) ?? []),
        embeddingText(branch),
      ]);
    }
    const bodies = new Map(
      [...branches].map(([id, texts]) => [
        id,
        unknown.has(id) ? undefined : texts.join("\n\n"),
      ]),
    );
    lowered.set(file, bodies);
    return bodies;
  };
  return (id) => {
    const node = nodes.get(id);
    return node === undefined ? undefined : lowerOnce(node.file).get(id);
  };
}
