import { z } from "zod";
import { ApiInputError, issueText } from "../map.js";

// A changeset bump, weakest first; `none` is what a package with no counted changeset has.
export const BUMPS = ["none", "patch", "minor", "major"] as const;

export type Bump = (typeof BUMPS)[number];

export const bumpRank = (bump: Bump): number => BUMPS.indexOf(bump);

const BumpRuleSchema = z.strictObject({
  bump: z.enum(BUMPS),
  callout: z.boolean().default(false),
});

const TierRowSchema = z.strictObject({
  added: BumpRuleSchema,
  changed: BumpRuleSchema,
  removed: BumpRuleSchema,
});

// The caller's bump policy (SPEC §13.5): per tier and change kind, the least changeset bump and
// whether a callout is owed, plus the callout's marker text. Every rule is the caller's: there is
// no built-in row, and a tier the policy does not name is judged only by the caller's own
// `default`.
export const BumpPolicySchema = z.strictObject({
  callout: z.string().min(1, "the callout marker must be non-empty"),
  tiers: z.record(z.string().min(1, "a tier must be non-empty"), TierRowSchema),
  default: TierRowSchema.optional(),
});

export type BumpPolicy = z.infer<typeof BumpPolicySchema>;
export type BumpRule = z.infer<typeof BumpRuleSchema>;
export type TierRow = z.infer<typeof TierRowSchema>;

// Parses `policy` through `BumpPolicySchema`; the first refusal throws `ApiInputError`.
export function bumpPolicy(policy: unknown): BumpPolicy {
  const parsed = BumpPolicySchema.safeParse(policy);
  if (!parsed.success) {
    throw new ApiInputError(`invalid bump policy: ${issueText(parsed.error)}`);
  }
  return parsed.data;
}
