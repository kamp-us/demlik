import { z } from "zod";
import { ClusterReportSchema } from "./clusters.js";
import {
  DirectoryNodeSchema,
  FunctionNodeSchema,
  ModuleNodeSchema,
  ProvenanceSchema,
  SmellSchema,
  SummarySchema,
  ThresholdsSchema,
} from "./core.js";
import { CrossRuntimeReportSchema } from "./cross-runtime.js";
import { DataReportSchema } from "./data.js";
import { InterfaceWidthReportSchema } from "./interface-width.js";
import { ReachabilityReportSchema } from "./reachability.js";

export const GraphSchema = z.object({
  root: z.string(),
  provenance: ProvenanceSchema,
  thresholds: ThresholdsSchema,
  summary: SummarySchema,
  crossRuntime: CrossRuntimeReportSchema.nullable(),
  reachability: ReachabilityReportSchema.nullable(),
  clusters: ClusterReportSchema.nullable(),
  interfaceWidth: InterfaceWidthReportSchema.nullable(),
  data: DataReportSchema.nullable(),
  functions: z.array(FunctionNodeSchema),
  modules: z.array(ModuleNodeSchema),
  directories: z.array(DirectoryNodeSchema),
  smells: z.array(SmellSchema),
  stats: z.object({
    fileCount: z.number(),
    functionCount: z.number(),
    totalLoc: z.number(),
    totalCommentLines: z.number(),
    smellCount: z.number(),
    parseFailures: z.array(z.string()),
  }),
});
export type Graph = z.infer<typeof GraphSchema>;
