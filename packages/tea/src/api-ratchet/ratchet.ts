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
import { PKG_ROOT, readApiMap, type TeaApiMap } from "./api-map";
import { TEA_BUMP_POLICY } from "./policy";

type Miss = ApiRatchetVerdict["misses"][number];

export type RatchetRun = { readonly passed: boolean; readonly text: string };

const indent = (text: string, by: string): string =>
  text
    .split("\n")
    .map((line) => `${by}${line}`)
    .join("\n");

/**
 * The types a changed name uses whose text moved between the two sides. A name
 * folds in every type it reaches, and one edit rarely touches more than one of
 * them, so the rest would only bury the line that changed.
 */
function movedReferences(miss: Miss): ReadonlySet<string> {
  if (miss.before === null || miss.after === null) return new Set();
  const before = miss.before.references;
  const after = miss.after.references;
  return new Set(
    [...Object.keys(before), ...Object.keys(after)].filter(
      (key) => before[key] !== after[key],
    ),
  );
}

/** One side of a change: its declaration text, then each moved type it uses. */
function sideLines(
  label: string,
  side: ApiEntryText | null,
  moved: ReadonlySet<string>,
): string[] {
  if (side === null) return [];
  const references = Object.keys(side.references)
    .filter((key) => moved.has(key))
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
  const moved = movedReferences(miss);
  return [
    `api-ratchet: ${miss.name} in ${miss.subpath} (${miss.tier}) ${miss.kind} — needs ${owed(miss.needs, callout)}; found ${found(verdict, miss.needs)}`,
    ...sideLines("before", miss.before, moved),
    ...sideLines("after", miss.after, moved),
  ];
}

/**
 * A subpath the pull request deleted, as one block: the subpath, the tier the
 * base stamped it with and what its removal owes, then the names it published.
 * Every name of a deleted subpath is `removed` under one tier, so they all miss
 * the same rule and one line says it for the lot.
 */
function removedSubpathLines(
  misses: readonly Miss[],
  verdict: ApiRatchetVerdict,
  callout: string,
): string[] {
  const [first] = misses;
  if (first === undefined) return [];
  const names = misses.map((miss) => miss.name);
  const counted = `${names.length} ${names.length === 1 ? "name" : "names"}`;
  return [
    `api-ratchet: ${first.subpath} (${first.tier}) removed, with the ${counted} it published — needs ${owed(first.needs, callout)}; found ${found(verdict, first.needs)}`,
    `  removed: ${names.join(", ")}`,
  ];
}

/**
 * The subpaths the base published and the working tree's map no longer names:
 * the diff carries a key for each, and `map` has none.
 */
export const removedSubpaths = (
  diff: ApiDiff,
  map: Readonly<Record<string, unknown>>,
): ReadonlySet<string> =>
  new Set(
    Object.keys(diff.subpaths).filter(
      (subpath) => !Object.hasOwn(map, subpath),
    ),
  );

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
 * misses its bump — name, subpath, tier, what it needs, and its before and after
 * text with the types it uses that moved — then a summary line. A subpath in
 * `removed` gets one block for the whole subpath in place of one per name.
 * Nothing in it varies between two runs of one tree.
 */
export function renderVerdict(
  verdict: ApiRatchetVerdict,
  changes: number,
  callout: string,
  removed: ReadonlySet<string> = new Set(),
): string {
  const base = verdict.base.slice(0, 7);
  const counted = `${changes} published ${changes === 1 ? "name" : "names"} changed`;
  if (verdict.passed) {
    return `api-ratchet: pass — ${counted} against ${base}; ${verdict.package} changesets since: ${verdict.changesets.length}, highest bump ${verdict.highestBump}\n`;
  }
  // The misses arrive sorted by subpath, so a deleted subpath's are adjacent:
  // its block goes where its first miss stands.
  const blocks = verdict.misses.flatMap((miss, at, misses) => {
    if (!removed.has(miss.subpath)) return missLines(miss, verdict, callout);
    if (misses[at - 1]?.subpath === miss.subpath) return [];
    const ofSubpath = misses.filter((m) => m.subpath === miss.subpath);
    return removedSubpathLines(ofSubpath, verdict, callout);
  });
  const summary = `api-ratchet: ${verdict.misses.length} of ${counted} against ${base} without the changeset MAINTAINING.md's semver policy asks for — add one with \`pnpm changeset\``;
  return `${[...blocks, summary].join("\n")}\n`;
}

/** The base commit's API map, read from the base tree's own three files. */
async function readBaseApiMap(baseRoot: string): Promise<TeaApiMap> {
  try {
    return await readApiMap(baseRoot);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `api-ratchet: could not read the API map of the base commit: ${reason}`,
    );
  }
}

/**
 * Run the ratchet on the working tree of the package at `root` against the
 * commit `base` names. Each side is read through its own map: the working
 * tree's, and the one the base commit's files state. A subpath only the base
 * has comes back with the base's tier and every name `removed`, so the policy's
 * `removed` row judges a deleted subpath as it judges one deleted name.
 */
export async function runApiRatchet(
  base: string,
  root: string = PKG_ROOT,
): Promise<RatchetRun> {
  const map = await readApiMap(root);
  const diff = await diffPublishedApi(root, map, base, {
    baseMap: readBaseApiMap,
  });
  const verdict = ratchetApiDiff(
    diff,
    TEA_BUMP_POLICY,
    readChangesetsSince(root, diff.base),
  );
  return {
    passed: verdict.passed,
    text: renderVerdict(
      verdict,
      changeCount(diff),
      TEA_BUMP_POLICY.callout,
      removedSubpaths(diff, map),
    ),
  };
}
