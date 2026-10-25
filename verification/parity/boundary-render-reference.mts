import { z } from "zod";
import {
  BOUNDARY_KINDS,
  ledgerKey,
} from "../../packages/code-graph/src/boundaries/ledger.js";
import { reconcile } from "../../packages/code-graph/src/boundaries/reconcile.js";
import {
  renderAccepted,
  renderBoundaries,
  renderLedgerGate,
  renderMigrated,
  renderMigrationRefused,
} from "../../packages/code-graph/src/boundaries/render.js";

export const scalarSchema = z.union([
  z.custom<number>((value) => typeof value === "number"),
  z.enum(["nan", "inf", "-inf", "-0"]),
]);
export type Scalar = z.infer<typeof scalarSchema>;
export function scalar(value: Scalar): number {
  if (typeof value === "number") return value;
  switch (value) {
    case "nan":
      return Number.NaN;
    case "inf":
      return Number.POSITIVE_INFINITY;
    case "-inf":
      return Number.NEGATIVE_INFINITY;
    case "-0":
      return -0;
  }
}
const strings = z.array(z.string());
function dictionary<T>(entry: z.ZodType<T>) {
  // Census facts are records, including own constructor/__proto__ keys, not config schemas.
  return z.custom<Record<string, T>>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.values(value).every((item) => entry.safeParse(item).success),
  );
}
const writeSchema = z
  .object({ file: z.string(), line: scalarSchema, binding: z.string() })
  .strict();
const base = { from: z.string(), specifier: z.string(), typeOnly: z.boolean() };
export const violationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...base,
      kind: z.literal("cross-feature"),
      to: z.string(),
      fromFeature: z.string(),
      toFeature: z.string(),
    })
    .strict(),
  z.object({ ...base, kind: z.literal("impure"), to: z.null() }).strict(),
  z
    .object({
      ...base,
      kind: z.literal("lib-imports-feature"),
      to: z.string(),
      toFeature: z.string(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("outside-imports-feature-internal"),
      to: z.string(),
      toFeature: z.string(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("application-imports-adapter"),
      to: z.string(),
      feature: z.string(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("driving-reaches-driven"),
      to: z.string(),
      feature: z.string(),
      write: writeSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("index-not-exports-only"),
      to: z.null(),
      typeOnly: z.literal(false),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("application-import-outside-allowlist"),
      to: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("unknown-zone"),
      to: z.null(),
      typeOnly: z.literal(false),
      feature: z.string(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("library-undeclared"),
      to: z.null(),
      typeOnly: z.literal(false),
    })
    .strict(),
  z
    .object({ ...base, kind: z.literal("library-imports-up"), to: z.string() })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("adapter-library-imported-outside-driven"),
      to: z.string(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("binding-outside-driven-adapter"),
      to: z.null(),
      typeOnly: z.literal(false),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("worker-call-cycle"),
      to: z.null(),
      typeOnly: z.literal(false),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("relative-import-crosses-workspace"),
      to: z.string(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("test-reaches-composition-root"),
      to: z.string(),
      typeOnly: z.literal(false),
    })
    .strict(),
]);
export type Violation = z.infer<typeof violationSchema>;
export const reportSchema = z
  .object({
    scope: z.string(),
    features: strings,
    filesScanned: scalarSchema,
    violations: z.array(violationSchema),
    workers: strings.optional(),
  })
  .strict();
const entrySchema = z
  .object({
    scope: z.string(),
    kind: z.enum(BOUNDARY_KINDS),
    from: z.string(),
    to: z.string().nullable(),
    specifier: z.string(),
    reason: z.string().optional(),
  })
  .strict();
export const ledgerSchema = z
  .object({ entries: z.array(entrySchema) })
  .strict();
const librarySchema = z
  .object({
    types: dictionary(strings),
    undeclared: strings,
    unjudgedImports: scalarSchema,
  })
  .strict();
const workerSchema = z
  .object({
    worker: z.string(),
    files: strings,
    bindings: dictionary(scalarSchema),
    sites: z.array(writeSchema),
  })
  .strict();
const deployableSchema = z
  .object({
    workers: z.array(workerSchema),
    unresolvedServiceBindings: scalarSchema,
  })
  .strict();
export const censusesSchema = z
  .object({
    libraries: librarySchema.nullable(),
    deployables: deployableSchema.nullable(),
  })
  .strict();
export const stateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("reconciled"),
      ledger: ledgerSchema,
      reports: z.array(reportSchema),
      under: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("opaque"),
      scopesChecked: scalarSchema,
      unrecorded: z.array(entrySchema),
      pruned: z.array(entrySchema),
      kept: ledgerSchema,
      writes: z.array(
        z.object({ entry: entrySchema, write: writeSchema }).strict(),
      ),
    })
    .strict(),
]);
const breachSchema = z
  .object({ scope: z.string(), measured: scalarSchema, ceiling: scalarSchema })
  .strict();
export const renderSchemas = {
  "code_graph.boundary-render": z
    .object({
      reports: z.array(reportSchema),
      under: z.string(),
      censuses: censusesSchema,
      json: z.boolean(),
      pretty: z.boolean(),
    })
    .strict(),
  "code_graph.boundary-ledger-render": z
    .object({ result: stateSchema, json: z.boolean(), pretty: z.boolean() })
    .strict(),
  "code_graph.boundary-accepted-render": z
    .object({
      result: stateSchema,
      reason: z.string(),
      json: z.boolean(),
      pretty: z.boolean(),
    })
    .strict(),
  "code_graph.boundary-migrated-render": z
    .object({
      ledger: ledgerSchema,
      scopes: scalarSchema,
      json: z.boolean(),
      pretty: z.boolean(),
    })
    .strict(),
  "code_graph.boundary-refusal-render": z
    .object({ breaches: z.array(breachSchema) })
    .strict(),
};
export type Operation = keyof typeof renderSchemas;
export type RenderCase = {
  [Operation in keyof typeof renderSchemas]: {
    id: string;
    operation: Operation;
    input: z.infer<(typeof renderSchemas)[Operation]>;
  };
}[Operation];
export function renderCase(
  id: string,
  operation: Operation,
  input: unknown,
): RenderCase {
  switch (operation) {
    case "code_graph.boundary-render":
      return { id, operation, input: renderSchemas[operation].parse(input) };
    case "code_graph.boundary-ledger-render":
      return { id, operation, input: renderSchemas[operation].parse(input) };
    case "code_graph.boundary-accepted-render":
      return { id, operation, input: renderSchemas[operation].parse(input) };
    case "code_graph.boundary-migrated-render":
      return { id, operation, input: renderSchemas[operation].parse(input) };
    case "code_graph.boundary-refusal-render":
      return { id, operation, input: renderSchemas[operation].parse(input) };
  }
}
function sourceReport(report: z.infer<typeof reportSchema>) {
  return {
    ...report,
    filesScanned: scalar(report.filesScanned),
    violations: report.violations.map((violation) => {
      if (violation.kind !== "driving-reaches-driven") return violation;
      const { write, ...edge } = violation;
      return write === undefined
        ? edge
        : { ...edge, write: { ...write, line: scalar(write.line) } };
    }),
  };
}
function sourceCensuses(censuses: z.infer<typeof censusesSchema>) {
  return {
    libraries:
      censuses.libraries === null
        ? null
        : {
            ...censuses.libraries,
            unjudgedImports: scalar(censuses.libraries.unjudgedImports),
          },
    deployables:
      censuses.deployables === null
        ? null
        : {
            ...censuses.deployables,
            unresolvedServiceBindings: scalar(
              censuses.deployables.unresolvedServiceBindings,
            ),
            workers: censuses.deployables.workers.map((worker) => ({
              ...worker,
              bindings: Object.fromEntries(
                Object.entries(worker.bindings).map(([name, count]) => [
                  name,
                  scalar(count),
                ]),
              ),
              sites: worker.sites.map((site) => ({
                ...site,
                line: scalar(site.line),
              })),
            })),
          },
  };
}
function sourceState(state: z.infer<typeof stateSchema>) {
  if (state.kind === "reconciled")
    return reconcile(
      state.ledger,
      state.reports.map(sourceReport),
      state.under,
    );
  return {
    ...state,
    scopesChecked: scalar(state.scopesChecked),
    writes: new Map(
      state.writes.map(({ entry, write }) => [
        ledgerKey(entry),
        { ...write, line: scalar(write.line) },
      ]),
    ),
  };
}
export function boundaryRenderReference(item: RenderCase): unknown {
  switch (item.operation) {
    case "code_graph.boundary-render":
      return renderBoundaries(
        item.input.reports.map(sourceReport),
        item.input.under,
        sourceCensuses(item.input.censuses),
        item.input.json,
        item.input.pretty,
      );
    case "code_graph.boundary-ledger-render":
      return renderLedgerGate(
        sourceState(item.input.result),
        item.input.json,
        item.input.pretty,
      );
    case "code_graph.boundary-accepted-render":
      return renderAccepted(
        sourceState(item.input.result),
        item.input.reason,
        item.input.json,
        item.input.pretty,
      );
    case "code_graph.boundary-migrated-render":
      return renderMigrated(
        item.input.ledger,
        scalar(item.input.scopes),
        item.input.json,
        item.input.pretty,
      );
    case "code_graph.boundary-refusal-render":
      return renderMigrationRefused(
        item.input.breaches.map((breach) => ({
          ...breach,
          measured: scalar(breach.measured),
          ceiling: scalar(breach.ceiling),
        })),
      );
  }
}
