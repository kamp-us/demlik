import { z } from "zod";

export const DataBindingKindSchema = z.enum(["d1", "durable-object", "kv", "queue", "r2"]);
export type DataBindingKind = z.infer<typeof DataBindingKindSchema>;

// `unknown` is a stated answer, not a missing one: the call site touches the binding and nothing
// at the site says which way.
export const DataAccessSchema = z.enum(["read", "unknown", "write"]);
export type DataAccess = z.infer<typeof DataAccessSchema>;

export const DataEdgeSchema = z.object({
  functionId: z.string(),
  line: z.number(),
  ownerService: z.string(),
  binding: z.string(),
  bindingKind: DataBindingKindSchema,
  // The member called on the binding (`get`, `prepare`); null when the binding is handed on whole.
  method: z.string().nullable(),
  access: DataAccessSchema,
});
export type DataEdge = z.infer<typeof DataEdgeSchema>;

export const DataReportSchema = z.object({
  configFiles: z.array(z.string()),
  unparsedConfigs: z.array(z.string()),
  edges: z.array(DataEdgeSchema),
});
export type DataReport = z.infer<typeof DataReportSchema>;
