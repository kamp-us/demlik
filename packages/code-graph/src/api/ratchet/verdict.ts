import type { ApiDiff, SubpathDiff } from "../diff.js";
import { ApiInputError } from "../map.js";
import type { ApiEntryText } from "../read.js";
import type { ChangesetsSince } from "./changesets.js";
import { type Bump, type BumpPolicy, type BumpRule, bumpPolicy, bumpRank } from "./policy.js";

export type ChangeKind = "added" | "changed" | "removed";

// One name the diff reports: `before` is null for an added name, `after` for a removed one.
export type ApiChange = {
  readonly subpath: string;
  readonly tier: string | null;
  readonly name: string;
  readonly kind: ChangeKind;
  readonly before: ApiEntryText | null;
  readonly after: ApiEntryText | null;
};

// A change whose rule the package's changesets do not meet, with the rule it needed.
export type ApiRatchetMiss = ApiChange & { readonly needs: BumpRule };

// The ratchet's answer (SPEC §13.5): which changes miss the bump the caller's policy asks of them.
export type ApiRatchetVerdict = {
  readonly passed: boolean;
  readonly base: string;
  readonly package: string;
  readonly changesets: readonly string[];
  readonly highestBump: Bump;
  readonly calloutFound: boolean;
  readonly misses: readonly ApiRatchetMiss[];
};

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function subpathChanges(subpath: string, diff: SubpathDiff): readonly ApiChange[] {
  const at = { subpath, tier: diff.tier };
  return [
    ...Object.entries(diff.added).map(
      ([name, { after }]): ApiChange => ({ ...at, name, kind: "added", before: null, after }),
    ),
    ...Object.entries(diff.changed).map(
      ([name, { before, after }]): ApiChange => ({ ...at, name, kind: "changed", before, after }),
    ),
    ...Object.entries(diff.removed).map(
      ([name, { before }]): ApiChange => ({ ...at, name, kind: "removed", before, after: null }),
    ),
  ];
}

// Every name the diff reports, sorted by subpath, then name, then kind.
export function apiChanges(diff: ApiDiff): readonly ApiChange[] {
  return Object.keys(diff.subpaths)
    .sort(byText)
    .flatMap((subpath) =>
      [...subpathChanges(subpath, diff.subpaths[subpath] as SubpathDiff)].sort(
        (a, b) => byText(a.name, b.name) || byText(a.kind, b.kind),
      ),
    );
}

// The policy's rule for one change: its tier's row, else the caller's `default`. A change no row
// covers is refused, so nothing passes unpoliced.
function ruleFor(policy: BumpPolicy, change: ApiChange): BumpRule {
  const { tier, subpath } = change;
  const row =
    tier !== null && Object.hasOwn(policy.tiers, tier) ? policy.tiers[tier] : policy.default;
  if (row !== undefined) return row[change.kind];
  const tierNamed = tier === null ? "no tier" : `tier "${tier}"`;
  throw new ApiInputError(
    `bump policy: subpath ${subpath} has ${tierNamed}, which the policy gives no row and no default`,
  );
}

// Judges `diff` against the caller's `policy` and the package's counted `changesets` (SPEC §13.5).
// Pure: it reads nothing but its arguments. A change misses when its rule's bump is above the
// highest counted bump, or when its rule asks for the callout and no counted changeset's body
// carries the policy's marker. Throws `ApiInputError` on an invalid policy, or on a change whose
// tier the policy does not cover.
export function ratchetApiDiff(
  diff: ApiDiff,
  policy: unknown,
  changesets: ChangesetsSince,
): ApiRatchetVerdict {
  const rules = bumpPolicy(policy);
  const counted = changesets.changesets;
  const highestBump = counted.reduce<Bump>(
    (highest, { bump }) => (bumpRank(bump) > bumpRank(highest) ? bump : highest),
    "none",
  );
  const calloutFound = counted.some(({ body }) => body.includes(rules.callout));
  const misses = apiChanges(diff).flatMap((change): ApiRatchetMiss[] => {
    const needs = ruleFor(rules, change);
    const met = bumpRank(needs.bump) <= bumpRank(highestBump) && (!needs.callout || calloutFound);
    return met ? [] : [{ ...change, needs }];
  });
  return {
    passed: misses.length === 0,
    base: diff.base,
    package: changesets.package,
    changesets: counted.map(({ file }) => file).sort(byText),
    highestBump,
    calloutFound,
    misses,
  };
}
