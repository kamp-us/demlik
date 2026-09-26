import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { PAIR_VERDICTS, type PairVerdict } from "../pairs/questions.js";
import type { InputName } from "./levers.js";

/**
 * One input file as the inventory holds it: read, or missing. `path` is the path as the caller
 * named it (never resolved), so the same inputs print the same bytes on every machine; a missing
 * input keeps the flag that names it and the path it looked at, or `null` when no path was given.
 */
export type Source<T> =
  | { readonly _tag: "read"; readonly path: string; readonly value: T }
  | {
      readonly _tag: "missing";
      readonly flag: string;
      readonly path: string | null;
    };

const GraphFunctionRow = z.object({
  id: z.string(),
  name: z.string(),
  file: z.string(),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  isExported: z.boolean(),
  isTest: z.boolean(),
});

/** The slice of one code-graph `--graph` function node the inventory reads. */
export type GraphFunctionRow = z.infer<typeof GraphFunctionRow>;

/** The slice of a code-graph `--graph` JSON file the inventory reads. */
export const GraphInput = z.object({ functions: z.array(GraphFunctionRow) });
export type GraphInput = z.infer<typeof GraphInput>;

const UnreachableRow = z.object({
  id: z.string(),
  file: z.string(),
  startLine: z.number().int().min(1),
  category: z.enum(["dead", "only-called-from-tests"]),
  testReferences: z.array(z.string()),
});

/**
 * Unreachable exports, from either `code-graph --unreachable --json` or a `--graph --unreachable`
 * dump. The dump also carries each function's end line, which the bare report does not.
 */
export const UnreachableInput = z.union([
  z
    .object({ unreachable: z.array(UnreachableRow) })
    .transform((r) => ({ unreachable: r.unreachable, functions: [] })),
  z
    .object({
      reachability: z.object({ unreachable: z.array(UnreachableRow) }),
      functions: z.array(GraphFunctionRow),
    })
    .transform((g) => ({
      unreachable: g.reachability.unreachable,
      functions: g.functions,
    })),
]);
export type UnreachableInput = z.infer<typeof UnreachableInput>;

/** The slice of a `consolidate.json` (`ConsolidationPlan`) the inventory reads. */
export const ConsolidateInput = z.object({
  ref: z.string(),
  minCluster: z.number().int().min(2),
  merge: z
    .array(
      z.object({
        scope: z.string(),
        feature: z.string(),
        role: z.string(),
        files: z.array(
          z.object({ path: z.string(), lines: z.number().int().min(0) }),
        ),
      }),
    )
    .nullable(),
});
export type ConsolidateInput = z.infer<typeof ConsolidateInput>;

const PairSide = z.object({
  path: z.string(),
  function: z.string(),
  lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
});

/** The slice of one `pairs.json` row the inventory reads. */
export const PairInput = z.object({
  id: z.string(),
  a: PairSide,
  b: PairSide,
  answers: z.object({
    verdict: z.object({
      choice: z.enum(PAIR_VERDICTS as [PairVerdict, ...PairVerdict[]]),
      confidence: z.number().min(0).max(1),
    }),
  }),
});
export type PairInput = z.infer<typeof PairInput>;

export const PairsInput = z.array(PairInput);

/**
 * `path` parsed by `schema`, or missing when there is no such file. A file that exists but does
 * not parse throws: a broken input is not a skipped lever.
 */
export function readSource<T>(
  input: { readonly flag: string; readonly path: string | undefined },
  resolve: (path: string) => string,
  schema: z.ZodType<T>,
): Source<T> {
  if (input.path === undefined)
    return { _tag: "missing", flag: input.flag, path: null };
  const absolute = resolve(input.path);
  if (!existsSync(absolute))
    return { _tag: "missing", flag: input.flag, path: input.path };
  try {
    return {
      _tag: "read",
      path: input.path,
      value: schema.parse(JSON.parse(readFileSync(absolute, "utf8"))),
    };
  } catch (error) {
    throw new Error(
      `${input.path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The flag that names each input on the command line. */
export const INPUT_FLAGS: Readonly<Record<InputName, string>> = {
  unreachable: "--unreachable",
  graph: "--graph",
  consolidate: "--consolidate",
  pairs: "--pairs",
  groups: "--groups",
};
