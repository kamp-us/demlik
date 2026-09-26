import { z } from "zod";
import { smellKinds } from "../smells/rules.js";

export const SmellKindSchema = z.enum(smellKinds());

export const ThresholdsSchema = z
  .object({
    longFunctionLoc: z.number().int().nonnegative().default(60),
    deepNesting: z.number().int().nonnegative().default(4),
    highComplexity: z.number().int().nonnegative().default(10),
    bigFileLoc: z.number().int().nonnegative().default(400),
    highFanIn: z.number().int().nonnegative().default(10),
    deepCallChain: z.number().int().nonnegative().default(5),
    directorySprawl: z.number().int().nonnegative().default(10),
    dependencyCycle: z.number().int().nonnegative().default(1),
    crossBoundaryImports: z.number().int().nonnegative().default(0),
  })
  .strict();
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export const SmellTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("function"),
    id: z.string(),
    file: z.string(),
    startLine: z.number(),
  }),
  z.object({ type: z.literal("module"), file: z.string() }),
  z.object({ type: z.literal("directory"), dir: z.string() }),
]);
export type SmellTarget = z.infer<typeof SmellTargetSchema>;

export const SmellSchema = z.object({
  kind: SmellKindSchema,
  target: SmellTargetSchema,
  value: z.number(),
  threshold: z.number(),
  severity: z.enum(["warn", "high"]),
});
export type Smell = z.infer<typeof SmellSchema>;

export const FunctionKindSchema = z.enum([
  "function",
  "method",
  "constructor",
  "getter",
  "setter",
  "arrow",
  "function-expression",
]);
export type FunctionKind = z.infer<typeof FunctionKindSchema>;

export const CallSiteSchema = z.object({
  calleeId: z.string(),
  line: z.number(),
  constArgs: z.array(z.string()).default([]),
  declaration: z.string().nullable().default(null),
});
export type CallSite = z.infer<typeof CallSiteSchema>;

export const CallerSiteSchema = z.object({
  callerId: z.string(),
  line: z.number(),
});
export type CallerSite = z.infer<typeof CallerSiteSchema>;

export const ImportEdgeKindSchema = z.enum(["static", "export-from", "dynamic"]);
export type ImportEdgeKind = z.infer<typeof ImportEdgeKindSchema>;

export const ImportEdgeSchema = z.object({
  specifier: z.string(),
  kind: ImportEdgeKindSchema,
  typeOnly: z.boolean(),
  target: z.string().nullable(),
});
export type ImportEdge = z.infer<typeof ImportEdgeSchema>;

export const EdgesSchema = z.object({
  calls: z.array(CallSiteSchema),
  calledBy: z.array(CallerSiteSchema),
  callChainDepth: z.number(),
});
export type Edges = z.infer<typeof EdgesSchema>;

export const EntryReachSchema = z.enum(["public", "service-binding", "platform"]);
export type EntryReach = z.infer<typeof EntryReachSchema>;

export const NodeKindSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("entry"),
    evidence: z.array(z.string()),
    guards: z.array(z.string()),
    reach: EntryReachSchema,
  }),
  z.object({ kind: z.literal("auth"), evidence: z.array(z.string()) }),
  z.object({ kind: z.literal("effect"), evidence: z.array(z.string()) }),
  z.object({ kind: z.literal("plain") }),
]);
export type NodeKind = z.infer<typeof NodeKindSchema>;
export type NodeKindName = NodeKind["kind"];

export const FunctionNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: FunctionKindSchema,
  file: z.string(), // relative to the analyzed root (join with graph.root for absolute)
  startLine: z.number(),
  endLine: z.number(),
  loc: z.number(),
  commentLines: z.number(),
  nestingDepth: z.number(),
  complexity: z.number(),
  isExported: z.boolean(),
  isTest: z.boolean(),
  edges: EdgesSchema.nullable(),
  nodeKind: NodeKindSchema.nullable(),
  smells: z.array(SmellSchema),
});
export type FunctionNode = z.infer<typeof FunctionNodeSchema>;

export const ModuleNodeSchema = z.object({
  file: z.string(), // relative to the analyzed root (join with graph.root for absolute)
  loc: z.number(),
  commentLines: z.number(),
  functionIds: z.array(z.string()),
  imports: z.array(z.string()),
  importedBy: z.array(z.string()),
  importEdges: z.array(ImportEdgeSchema),
  isTest: z.boolean(),
  smells: z.array(SmellSchema),
});
export type ModuleNode = z.infer<typeof ModuleNodeSchema>;

export const DirectoryNodeSchema = z.object({
  dir: z.string(), // directory relative to the analyzed root
  fileCount: z.number(),
  functionCount: z.number(),
  files: z.array(z.string()),
  smells: z.array(SmellSchema),
});
export type DirectoryNode = z.infer<typeof DirectoryNodeSchema>;

export const PlanRowSchema = z.object({
  id: z.string(),
  file: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  score: z.number(),
  components: z.object({
    smells: z.number(),
    complexity: z.number(),
    fanIn: z.number().nullable(),
  }),
  loc: z.number(),
  complexity: z.number(),
  calledByCount: z.number().nullable(),
  smells: z.array(SmellSchema),
});
export type PlanRow = z.infer<typeof PlanRowSchema>;

export const ProvenanceSchema = z.discriminatedUnion("pass", [
  z.object({ pass: z.literal("cheap") }),
  z.object({
    pass: z.literal("edges"),
    tsConfig: z.string(),
    scope: z.enum(["package", "deep"]),
  }),
]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const SummarySchema = z.object({
  health: z.enum(["healthy", "rough", "rotten"]),
  fileCount: z.number(),
  functionCount: z.number(),
  smellCount: z.number(),
  highSeverityCount: z.number(),
  worstFile: z.string().nullable(),
  worstFunction: z.string().nullable(),
  topTargets: z.array(PlanRowSchema),
  parseFailures: z.array(z.string()),
});
export type Summary = z.infer<typeof SummarySchema>;
