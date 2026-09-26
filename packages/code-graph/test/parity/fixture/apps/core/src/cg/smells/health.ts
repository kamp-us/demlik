import type { Summary } from "../schema.js";

export function healthBand(input: {
  smellCount: number;
  highSeverityCount: number;
  fileCount: number;
}): Summary["health"] {
  const { smellCount, highSeverityCount, fileCount } = input;
  const density = smellCount / Math.max(fileCount, 1);
  if (highSeverityCount > 5 || density >= 1.0) return "rotten";
  if (highSeverityCount === 0 && density < 0.3) return "healthy";
  return "rough";
}
