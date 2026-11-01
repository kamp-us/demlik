/**
 * tea's bump policy: what changeset a change to a published name owes, by the
 * tier of its subpath. This is `MAINTAINING.md`'s "Semver policy" section, with
 * ADR 0016 for removals, in the shape `@demlik/code-graph/api`'s ratchet reads.
 * It is written here once; when the policy text changes, this changes with it.
 *
 *   - `stable` and `battery`: a changed name lands in a `minor` with a
 *     breaking-change callout or the additive marker; a removed name lands in a
 *     `minor` with the breaking-change callout; an added name owes a `minor` and
 *     no callout.
 *   - `experimental`: any change owes a changeset of any bump, and no callout.
 *
 * The callout marker is how tea's changesets flag a break: a leading
 * `**Breaking` (`CHANGELOG.md`). The additive marker is the author's word that
 * the change adds to the declaration and an ordinary call still compiles. The
 * check cannot tell the two apart from the text, so it asks for one of them
 * (https://github.com/kamp-us/demlik/issues/777#issuecomment-6564371162).
 */

import type { Tier } from "../docs/reference/tier-table";

type BumpRule = {
  readonly bump: "patch" | "minor" | "major";
  readonly callout?: true | { readonly or: string };
};

type TierRow = {
  readonly added: BumpRule;
  readonly changed: BumpRule;
  readonly removed: BumpRule;
};

export type TeaBumpPolicy = {
  readonly callout: string;
  /** One row per tier: a tier with no row does not typecheck. */
  readonly tiers: Readonly<Record<Tier, TierRow>>;
};

const BREAK_IN_A_MINOR: TierRow = {
  added: { bump: "minor" },
  changed: { bump: "minor", callout: { or: "**Additive (declaration only)" } },
  removed: { bump: "minor", callout: true },
};

export const TEA_BUMP_POLICY: TeaBumpPolicy = {
  callout: "**Breaking",
  tiers: {
    stable: BREAK_IN_A_MINOR,
    battery: BREAK_IN_A_MINOR,
    experimental: {
      added: { bump: "patch" },
      changed: { bump: "patch" },
      removed: { bump: "patch" },
    },
  },
};
