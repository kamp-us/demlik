import { derived, type Fact, unknownValue } from "./fact.js";
import type { RuleGroup } from "./group.js";
import type { Owner } from "./owner.js";

/**
 * The label stage 5 could not derive, because one branch cannot show it duplicates another. It is
 * derived here from confirmed stage-6 groups and their stage-7 owners, with no Jev call, and it is
 * never a key of stage 5's question.
 */
export const REDERIVED = "rederived";

/**
 * One fact per member branch of a confirmed rule group. A member is `rederived` (true) when its
 * group's settled owner is a different member, and not (false) when it is the owner. A member of a
 * group whose owner is `unknown` — or that has no stage-7 fact — reads `unknown`, never a guess. A
 * branch in several groups is `rederived` when any of them says so, and `unknown` when none does
 * and any is unsettled.
 */
export function deriveRederived(
  groups: readonly Fact<RuleGroup>[],
  owners: readonly Fact<Owner>[],
): readonly Fact<boolean>[] {
  const ownerOf = new Map(owners.map((o) => [o.id, o.value]));
  const verdicts = new Map<
    string,
    { span: Fact<boolean>["span"]; says: ("yes" | "no" | "unknown")[] }
  >();
  for (const group of groups) {
    if (group.value._tag !== "known") continue;
    const owner = ownerOf.get(group.id);
    for (const member of group.value.value.members) {
      const entry = verdicts.get(member.branch) ?? {
        span: member.span,
        says: [],
      };
      entry.says.push(
        owner?._tag !== "known"
          ? "unknown"
          : owner.value.member === member.branch
            ? "no"
            : "yes",
      );
      verdicts.set(member.branch, entry);
    }
  }
  return [...verdicts]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, { span, says }]) => ({
      id,
      span,
      value: says.includes("yes")
        ? derived(true)
        : says.includes("unknown")
          ? unknownValue("undetermined")
          : derived(false),
    }));
}
