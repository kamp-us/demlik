/**
 * The published-API ratchet for tea: diff what every export subpath publishes
 * against a base commit, and hold each change to the changeset its tier's
 * policy asks for. The diff, the changeset read and the verdict are
 * `@demlik/code-graph/api`'s; tea supplies its map and its policy, and prints
 * the verdict.
 */

import {
  type ApiDiff,
  type ApiEntryText,
  type ApiRatchetVerdict,
  diffPublishedApi,
  ratchetApiDiff,
  readChangesetsSince,
} from "@demlik/code-graph/api";
import { PKG_ROOT, readApiMap } from "./api-map";
import { TEA_BUMP_POLICY } from "./policy";

type Miss = ApiRatchetVerdict["misses"][number];

export type RatchetRun = { readonly passed: boolean; readonly text: string };

const indent = (text: string, by: string): string =>
  text
    .split("\n")
    .map((line) => `${by}${line}`)
    .join("\n");

/** One side of a change: its declaration text, then each private type it uses. */
function sideLines(label: string, side: ApiEntryText | null): string[] {
  if (side === null) return [];
  const references = Object.keys(side.references)
    .sort()
    .map((key) => indent(`${key}: ${side.references[key]}`, "    "));
  return [`  ${label}:`, indent(side.text, "    "), ...references];
}

function owed(needs: Miss["needs"], callout: string): string {
  const bump = `a ${needs.bump} changeset`;
  return needs.callout
    ? `${bump} with a ${JSON.stringify(callout)} callout`
    : bump;
}

function found(verdict: ApiRatchetVerdict, needs: Miss["needs"]): string {
  if (verdict.highestBump === "none") return "no changeset";
  if (!needs.callout) return `a ${verdict.highestBump} changeset`;
  const callout = verdict.calloutFound ? "the" : "no";
  return `a ${verdict.highestBump} changeset with ${callout} callout`;
}

function missLines(
  miss: Miss,
  verdict: ApiRatchetVerdict,
  callout: string,
): string[] {
  return [
    `api-ratchet: ${miss.name} in ${miss.subpath} (${miss.tier}) ${miss.kind} — needs ${owed(miss.needs, callout)}; found ${found(verdict, miss.needs)}`,
    ...sideLines("before", miss.before),
    ...sideLines("after", miss.after),
  ];
}

/** How many published names the diff reports as added, changed or removed. */
export const changeCount = (diff: ApiDiff): number =>
  Object.values(diff.subpaths).reduce(
    (count, { added, changed, removed }) =>
      count +
      Object.keys(added).length +
      Object.keys(changed).length +
      Object.keys(removed).length,
    0,
  );

/**
 * The verdict as text: one line on a pass; on a miss, one block per change that
 * misses its bump — name, subpath, tier, what it needs and its before and after
 * text — then a summary line. Nothing in it varies between two runs of one tree.
 */
export function renderVerdict(
  verdict: ApiRatchetVerdict,
  changes: number,
  callout: string,
): string {
  const base = verdict.base.slice(0, 7);
  const counted = `${changes} published ${changes === 1 ? "name" : "names"} changed`;
  if (verdict.passed) {
    return `api-ratchet: pass — ${counted} against ${base}; ${verdict.package} changesets since: ${verdict.changesets.length}, highest bump ${verdict.highestBump}\n`;
  }
  const blocks = verdict.misses.flatMap((miss) =>
    missLines(miss, verdict, callout),
  );
  const summary = `api-ratchet: ${verdict.misses.length} of ${counted} against ${base} without the changeset MAINTAINING.md's semver policy asks for — add one with \`pnpm changeset\``;
  return `${[...blocks, summary].join("\n")}\n`;
}

/** Run the ratchet on the working tree against the commit `base` names. */
export async function runApiRatchet(base: string): Promise<RatchetRun> {
  const diff = await diffPublishedApi(PKG_ROOT, readApiMap(), base);
  const verdict = ratchetApiDiff(
    diff,
    TEA_BUMP_POLICY,
    readChangesetsSince(PKG_ROOT, diff.base),
  );
  return {
    passed: verdict.passed,
    text: renderVerdict(verdict, changeCount(diff), TEA_BUMP_POLICY.callout),
  };
}
