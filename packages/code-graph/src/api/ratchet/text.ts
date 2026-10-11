import type { ApiEntryText } from "../read.js";
import type { BumpRule } from "./policy.js";
import type { ApiRatchetMiss, ApiRatchetVerdict } from "./verdict.js";

// What the human verdict says beyond the verdict itself: how many changes the diff reported, and
// the policy's callout marker.
export type VerdictContext = { readonly changes: number; readonly callout: string };

const SHORT_SHA = 7;

const counted = (n: number): string => `${n} ${n === 1 ? "change" : "changes"}`;

const indented = (text: string, by: string): string =>
  text
    .split("\n")
    .map((line) => `${by}${line}`)
    .join("\n");

function entryLines(label: string, entry: ApiEntryText | null): readonly string[] {
  if (entry === null) return [];
  const references = Object.keys(entry.references)
    .sort()
    .map((key) => indented(`${key}: ${entry.references[key]}`, "    "));
  return [`  ${label}:`, indented(entry.text, "    "), ...references];
}

function needText(needs: BumpRule, callout: string): string {
  const bump = needs.bump === "none" ? "a changeset" : `a ${needs.bump} changeset`;
  return needs.callout ? `${bump} with a ${JSON.stringify(callout)} callout` : bump;
}

function foundText(verdict: ApiRatchetVerdict, needs: BumpRule): string {
  if (verdict.highestBump === "none" || !needs.callout) return verdict.highestBump;
  return `${verdict.highestBump} with ${verdict.calloutFound ? "the" : "no"} callout`;
}

function missLines(
  miss: ApiRatchetMiss,
  verdict: ApiRatchetVerdict,
  callout: string,
): readonly string[] {
  const tier = miss.tier ?? "no tier";
  const head = `API RATCHET: ${miss.name} in ${miss.subpath} (${tier}) ${miss.kind}`;
  return [
    `${head} — needs ${needText(miss.needs, callout)}; found ${foundText(verdict, miss.needs)}`,
    ...entryLines("before", miss.before),
    ...entryLines("after", miss.after),
  ];
}

// The human verdict (SPEC §13.5): one line on a pass; on a miss, one block per missing change
// with its before and after text, then a summary line.
export function renderApiRatchet(verdict: ApiRatchetVerdict, context: VerdictContext): string {
  const base = verdict.base.slice(0, SHORT_SHA);
  if (verdict.passed) {
    const callout = verdict.calloutFound ? "callout found" : "no callout";
    return `API RATCHET: pass — ${counted(context.changes)} against ${base}, highest changeset bump ${verdict.highestBump}, ${callout}\n`;
  }
  const blocks = verdict.misses.flatMap((miss) => missLines(miss, verdict, context.callout));
  const verb = verdict.misses.length === 1 ? "misses its" : "miss their";
  const summary = `API RATCHET: ${verdict.misses.length} of ${counted(context.changes)} ${verb} bump against ${base}`;
  return `${[...blocks, summary].join("\n")}\n`;
}
