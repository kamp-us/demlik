import { z } from "zod";

export const CrossRuntimeReasonSchema = z.enum([
  "target-service-unknown",
  "target-not-loaded",
  "ambiguous-target",
]);
export type CrossRuntimeReason = z.infer<typeof CrossRuntimeReasonSchema>;

export const CrossRuntimeEdgeSchema = z.object({
  binding: z.string(),
  bindingKind: z.enum(["service", "durable-object"]),
  callerId: z.string(),
  calleeId: z.string().nullable(),
  line: z.number(),
  method: z.string(),
  ownerService: z.string(),
  reason: CrossRuntimeReasonSchema.nullable(),
  targetClass: z.string(),
  targetService: z.string(),
});
export type CrossRuntimeEdge = z.infer<typeof CrossRuntimeEdgeSchema>;

export const BindingCensusRowSchema = z.object({
  binding: z.string(),
  bindingKind: z.enum(["service", "durable-object"]),
  callSites: z.number(),
  ownerService: z.string(),
  targetClass: z.string(),
  targetService: z.string(),
});
export type BindingCensusRow = z.infer<typeof BindingCensusRowSchema>;

export const CrossRuntimeReportSchema = z.object({
  configFiles: z.array(z.string()),
  unparsedConfigs: z.array(z.string()),
  census: z.array(BindingCensusRowSchema),
  edges: z.array(CrossRuntimeEdgeSchema),
});
export type CrossRuntimeReport = z.infer<typeof CrossRuntimeReportSchema>;
