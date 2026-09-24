import { z } from "zod";

export const ClusterFileGroupSchema = z.object({
  dir: z.string(),
  files: z.array(z.string()),
});
export type ClusterFileGroup = z.infer<typeof ClusterFileGroupSchema>;

export const ScatteredClusterSchema = z.object({
  id: z.string(),
  size: z.number(),
  dirCount: z.number(),
  dirs: z.array(ClusterFileGroupSchema),
});
export type ScatteredCluster = z.infer<typeof ScatteredClusterSchema>;

export const DirectoryClusterGroupSchema = z.object({
  clusterId: z.string(),
  files: z.array(z.string()),
});
export type DirectoryClusterGroup = z.infer<typeof DirectoryClusterGroupSchema>;

export const SplitDirectorySchema = z.object({
  dir: z.string(),
  fileCount: z.number(),
  clusterCount: z.number(),
  clusters: z.array(DirectoryClusterGroupSchema),
  isolatedFiles: z.array(z.string()),
});
export type SplitDirectory = z.infer<typeof SplitDirectorySchema>;

export const ClusterReportSchema = z.object({
  algorithm: z.literal("louvain-deterministic"),
  modularity: z.number(),
  clusterCount: z.number(),
  clusteredFileCount: z.number(),
  isolatedFileCount: z.number(),
  excludedTestFileCount: z.number(),
  scatteredClusters: z.array(ScatteredClusterSchema),
  splitDirectories: z.array(SplitDirectorySchema),
});
export type ClusterReport = z.infer<typeof ClusterReportSchema>;
