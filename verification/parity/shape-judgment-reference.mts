import path from "node:path";
import { z } from "zod";
import { readLibraries } from "../../packages/code-graph/src/boundaries/libraries/libraries.js";
import {
  BoundaryRulesSchema,
  placeOf,
  scopeZoning,
} from "../../packages/code-graph/src/boundaries/rules.js";
import { applicationViolations } from "../../packages/code-graph/src/boundaries/shape/application.js";
import { judgeShape } from "../../packages/code-graph/src/boundaries/shape/judge.js";
import {
  readShape,
  shapeFactsOf,
} from "../../packages/code-graph/src/boundaries/shape/shape.js";
import { loadEdgeProject } from "../../packages/code-graph/src/extract/project.js";
import { loadBindingCatalog } from "../../packages/code-graph/src/extract/wrangler-config.js";
import {
  resolveImports,
  runtimeSpecifiers,
} from "../../packages/code-graph/src/syntax/imports.js";

const strings = z.array(z.string());
export const edgeSchema = z
  .object({
    specifier: z.string(),
    kind: z.enum(["static", "export-from", "dynamic"]),
    typeOnly: z.boolean(),
    target: z.string().nullable(),
  })
  .strict();
const factsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("disk") }).strict(),
  z
    .object({
      kind: z.literal("opaque"),
      edges: z.array(edgeSchema),
      runtimeSpecifiers: strings,
      offendingForm: z.string().nullable(),
    })
    .strict(),
]);
export const shapeJudgmentSchema = z
  .object({
    repoRoot: z.string(),
    rules: z.unknown(),
    scope: z.string(),
    file: z.string(),
    facts: factsSchema,
    action: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("application"),
          feature: z.string(),
          own: z.array(
            z.enum([
              "index",
              "ports",
              "application",
              "driving",
              "driven",
              "unknown",
            ]),
          ),
        })
        .strict(),
      z.object({ kind: z.literal("judge"), placeFile: z.string() }).strict(),
    ]),
    judged: z.array(
      z
        .object({
          kind: z.enum(["original", "copy"]),
          index: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.facts.kind === "opaque") {
      for (const [index, item] of input.judged.entries()) {
        if (item.index >= input.facts.edges.length)
          context.addIssue({
            code: "custom",
            path: ["judged", index, "index"],
            message: "judged index does not name an import edge",
          });
      }
    }
  });
export type ShapeJudgmentInput = z.infer<typeof shapeJudgmentSchema>;
export function shapeJudgmentReference(input: ShapeJudgmentInput): unknown {
  try {
    const rules = BoundaryRulesSchema.parse(input.rules),
      catalog = loadBindingCatalog(input.repoRoot);
    const read = readShape(rules, catalog);
    if (read.kind === "refused") return read;
    const libraries = readLibraries(rules, input.repoRoot, undefined);
    if (libraries.kind !== "read") throw new Error(libraries.message);
    const shape = read.shape,
      zoning = scopeZoning(rules, input.scope);
    const held =
      input.facts.kind === "opaque"
        ? {
            edges: input.facts.edges,
            runtime: new Set(input.facts.runtimeSpecifiers),
            form: input.facts.offendingForm,
          }
        : (() => {
            const absolute = path.resolve(input.repoRoot, input.scope),
              loaded = loadEdgeProject(absolute, "package", input.repoRoot),
              unit = loaded.sourceFiles.find(
                (unit) => unit.file === input.file,
              );
            if (unit === undefined)
              throw new Error("file is not a loaded source file");
            const graph = resolveImports(
                absolute,
                loaded.sourceFiles,
                loaded.tsConfigPath,
              ),
              facts = shapeFactsOf(shape, input.scope, input.file, unit.syntax);
            return {
              edges: graph.importEdgesByFile.get(input.file) ?? [],
              runtime: runtimeSpecifiers(unit.syntax),
              form: facts.offendingForm,
            };
          })();
    const judged = new Set(
      input.judged.map((item) => {
        const edge = held.edges[item.index];
        if (edge === undefined)
          throw new Error("judged index does not name an import edge");
        return item.kind === "original" ? edge : { ...edge };
      }),
    );
    const shaped = {
      file: input.file,
      importEdges: held.edges,
      runtimeSpecifiers: held.runtime,
      offendingForm: held.form,
    };
    const violations =
      input.action.kind === "application"
        ? applicationViolations(
            {
              scope: input.scope,
              file: input.file,
              feature: input.action.feature,
              own: input.action.own,
              importEdges: held.edges,
              runtimeSpecifiers: held.runtime,
              judged,
            },
            {
              rules: shape,
              libraries: libraries.libraries,
              placeOf: (target) => placeOf(target, zoning),
            },
          )
        : judgeShape(
            {
              scope: input.scope,
              shape,
              libraries: libraries.libraries,
              zoning,
            },
            shaped,
            placeOf(input.action.placeFile, zoning),
            judged,
          );
    return {
      edges: held.edges,
      runtimeSpecifiers: [...held.runtime],
      offendingForm: held.form,
      violations,
    };
  } catch (error) {
    if (error instanceof Error)
      return { name: error.name, message: error.message };
    throw error;
  }
}
