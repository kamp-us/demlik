import { z } from "zod";

export const ExportWidthSchema = z.object({
  id: z.string(),
  name: z.string(),
  file: z.string(),
  startLine: z.number(),
  externalConsumers: z.array(z.string()), // files outside the declaring package
});
export type ExportWidth = z.infer<typeof ExportWidthSchema>;

export const PackageWidthSchema = z.object({
  package: z.string(), // analyzed-root-relative dir; "" is the analyzed root itself
  exportCount: z.number(),
  zeroConsumerCount: z.number(),
  exports: z.array(ExportWidthSchema),
});
export type PackageWidth = z.infer<typeof PackageWidthSchema>;

export const InterfaceWidthReportSchema = z.object({
  packages: z.array(PackageWidthSchema),
  totalExports: z.number(),
  totalZeroConsumer: z.number(),
});
export type InterfaceWidthReport = z.infer<typeof InterfaceWidthReportSchema>;
