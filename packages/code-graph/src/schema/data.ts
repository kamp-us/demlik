import { z } from "zod";

export const DataBindingKindSchema = z.enum(["d1", "durable-object", "kv", "queue", "r2"]);
export type DataBindingKind = z.infer<typeof DataBindingKindSchema>;

// `unknown` is a stated answer, not a missing one: the call site touches the binding and nothing
// at the site says which way.
export const DataAccessSchema = z.enum(["read", "unknown", "write"]);
export type DataAccess = z.infer<typeof DataAccessSchema>;

// One call site on a binding, before anyone says who holds it. `line` and `column` together are
// the site's identity: two calls on one line are two sites.
export const DataSiteSchema = z.object({
  line: z.number(),
  column: z.number(),
  ownerService: z.string(),
  binding: z.string(),
  bindingKind: DataBindingKindSchema,
  // The member called on the binding (`get`, `prepare`); null when the binding is handed on whole.
  method: z.string().nullable(),
  access: DataAccessSchema,
});
export type DataSite = z.infer<typeof DataSiteSchema>;

export const DataEdgeSchema = DataSiteSchema.extend({ functionId: z.string() });
export type DataEdge = z.infer<typeof DataEdgeSchema>;

// A site no discovered function holds: an anonymous callback at module scope, such as a Hono
// handler passed straight to `app.get`. It names its file because there is no function to name.
export const UnattributedDataSiteSchema = DataSiteSchema.extend({ file: z.string() });
export type UnattributedDataSite = z.infer<typeof UnattributedDataSiteSchema>;

export const DataReportSchema = z.object({
  configFiles: z.array(z.string()),
  unparsedConfigs: z.array(z.string()),
  edges: z.array(DataEdgeSchema),
  unattributed: z.array(UnattributedDataSiteSchema),
});
export type DataReport = z.infer<typeof DataReportSchema>;
