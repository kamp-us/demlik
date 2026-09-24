import { z } from "zod";
import { type CommentCensus, governedRatio } from "./census.js";

export const CEILINGS_FILENAME = "comment-ceilings.json";

export const CommentCeilingsSchema = z
  .object({
    default: z.number().nonnegative().default(40),
    slackPoints: z.number().nonnegative().default(2),
    scopes: z.record(z.string(), z.number().nonnegative()).default({}),
  })
  .strict();

export type CommentCeilings = z.infer<typeof CommentCeilingsSchema>;

export function toPoints(ratio: number): number {
  return Math.round(ratio * 1000) / 10;
}

export function ceilingPoints(ratio: number): number {
  return Math.ceil(Math.round(ratio * 10000) / 10) / 10;
}

const UNGOVERNED = /(^|\/)(fixtures|__fixtures__|opensrc)(\/|$)/;

export function isGovernedScope(scope: string): boolean {
  return !UNGOVERNED.test(scope);
}

export function ceilingsFromCensus(census: CommentCensus, base: CommentCeilings): CommentCeilings {
  const scopes: Record<string, number> = {};
  for (const row of census.scopes) {
    if (isGovernedScope(row.scope)) scopes[row.scope] = ceilingPoints(governedRatio(row));
  }
  return { default: base.default, slackPoints: base.slackPoints, scopes };
}
