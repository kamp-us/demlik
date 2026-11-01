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
  // The second markers the policy's rules name that a counted changeset's body carries, sorted.
  readonly otherMarkersFound: readonly string[];
  readonly misses: readonly ApiRatchetMiss[];
};

// Whether a rule's callout is met by the markers a verdict found. A rule asking for none is met.
export function calloutMet(
  rule: BumpRule,
  found: Pick<ApiRatchetVerdict, "calloutFound" | "otherMarkersFound">,
): boolean {
  const { callout } = rule;
  if (callout === false) return true;
  return found.calloutFound || (callout !== true && found.otherMarkersFound.includes(callout.or));
}

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

// Every second marker a rule of `policy` names, sorted, once each.
function otherMarkers(policy: BumpPolicy): readonly string[] {
  const rows = [...Object.values(policy.tiers), ...(policy.default ? [policy.default] : [])];
  const named = rows
    .flatMap(({ added, changed, removed }) => [added, changed, removed])
    .flatMap(({ callout }) => (typeof callout === "object" ? [callout.or] : []));
  return [...new Set(named)].sort(byText);
}

// Judges `diff` against the caller's `policy` and the package's counted `changesets` (SPEC §13.5).
// Pure: it reads nothing but its arguments. A change misses when its rule's bump is above the
// highest counted bump, or when its rule asks for a callout and no counted changeset's body
// carries a marker the rule accepts. Throws `ApiInputError` on an invalid policy, or on a change
// whose tier the policy does not cover.
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
  const carried = (marker: string) => counted.some(({ body }) => body.includes(marker));
  const found = {
    calloutFound: carried(rules.callout),
    otherMarkersFound: otherMarkers(rules).filter(carried),
  };
  const misses = apiChanges(diff).flatMap((change): ApiRatchetMiss[] => {
    const needs = ruleFor(rules, change);
    const met = bumpRank(needs.bump) <= bumpRank(highestBump) && calloutMet(needs, found);
    return met ? [] : [{ ...change, needs }];
  });
  return {
    passed: misses.length === 0,
    base: diff.base,
    package: changesets.package,
    changesets: counted.map(({ file }) => file).sort(byText),
    highestBump,
    ...found,
    misses,
  };
}
