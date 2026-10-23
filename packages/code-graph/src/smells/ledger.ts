import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { stableStringify } from "../render/json.js";
import type { Graph, Smell } from "../schema.js";
import { RULES, type SmellKind, smellKinds } from "./rules.js";

// `smell-ledger.json` at the repo root. `gated` names the smell rules the repo gates, none until
// named; `entries` holds one recorded smell per `(rule, target)` with the value it may not exceed.
// `--ci` fails on a smell of a gated rule the ledger does not name, or on a recorded one that got
// worse, and writes every improvement back, so the ledger only shrinks and tightens.
export const SMELL_LEDGER_FILENAME = "smell-ledger.json";

const KINDS = smellKinds();

const RuleNameSchema = z.enum(KINDS, {
  error: (issue) =>
    `"${String(issue.input)}" is not a smell rule; expected one of ${KINDS.join(", ")}`,
});

const EntrySchema = z
  .object({
    rule: RuleNameSchema,
    target: z.string().min(1),
    value: z.number().int().nonnegative(),
    reason: z.string().refine((reason) => reason.trim() !== "", "a reason must not be blank"),
  })
  .strict();

// `target` is repo-relative: a function's id (`<file>:<name>`, never its start line), a module's
// file, a directory's path. `value` is the measure recorded for it, such as a file's line count.
export type SmellLedgerEntry = z.infer<typeof EntrySchema>;
export type SmellFinding = Omit<SmellLedgerEntry, "reason">;
export type SmellLedger = {
  readonly gated: readonly SmellKind[];
  readonly entries: readonly SmellLedgerEntry[];
};

export function smellKey(finding: Pick<SmellFinding, "rule" | "target">): string {
  return JSON.stringify([finding.rule, finding.target]);
}

function duplicates(keys: readonly string[]): number[] {
  const seen = new Set<string>();
  return keys.flatMap((key, index) => {
    if (seen.has(key)) return [index];
    seen.add(key);
    return [];
  });
}

const SmellLedgerSchema = z
  .object({
    gated: z.array(RuleNameSchema).default([]),
    entries: z.array(EntrySchema).default([]),
  })
  .strict()
  .superRefine(({ gated, entries }, ctx) => {
    for (const index of duplicates(gated)) {
      ctx.addIssue({ code: "custom", message: "duplicate gated rule", path: ["gated", index] });
    }
    for (const index of duplicates(entries.map(smellKey))) {
      ctx.addIssue({ code: "custom", message: "duplicate entry", path: ["entries", index] });
    }
  });

function compareFindings(a: SmellFinding, b: SmellFinding): number {
  return a.rule.localeCompare(b.rule) || a.target.localeCompare(b.target);
}

// Sorted, one entry per key; on a collision the entry already held wins.
export function smellLedgerOf(
  gated: readonly SmellKind[],
  entries: readonly SmellLedgerEntry[],
): SmellLedger {
  const byKey = new Map<string, SmellLedgerEntry>();
  for (const entry of entries) {
    const key = smellKey(entry);
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return {
    gated: [...new Set(gated)].sort((a, b) => a.localeCompare(b)),
    entries: [...byKey.values()].sort(compareFindings),
  };
}

export type SmellLedgerRead =
  | { readonly kind: "absent" }
  | { readonly kind: "read"; readonly ledger: SmellLedger }
  | { readonly kind: "invalid"; readonly message: string };

export function parseSmellLedger(text: string): SmellLedgerRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid", message: "not valid JSON" };
  }
  const result = SmellLedgerSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { kind: "invalid", message: `${issue?.path.join(".") || "(root)"}: ${issue?.message}` };
  }
  return { kind: "read", ledger: smellLedgerOf(result.data.gated, result.data.entries) };
}

export function readSmellLedger(file: string): SmellLedgerRead {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid", message: "unreadable" };
  }
  return parseSmellLedger(text);
}

export function serializeSmellLedger(ledger: SmellLedger): string {
  return `${stableStringify(smellLedgerOf(ledger.gated, ledger.entries), true)}\n`;
}

export function writeSmellLedger(file: string, ledger: SmellLedger): void {
  fs.writeFileSync(file, serializeSmellLedger(ledger));
}

// A smell's target as a repo-relative string. `scope` is the analyzed path relative to the repo
// root (`.` for the root itself), and every graph path is relative to it.
export function repoTarget(scope: string, smell: Smell): string {
  const { target } = smell;
  switch (target.type) {
    case "function":
      return `${path.posix.join(scope, target.file)}${target.id.slice(target.file.length)}`;
    case "module":
      return path.posix.join(scope, target.file);
    case "directory":
      return path.posix.join(scope, target.dir);
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

export function findingsOf(scope: string, smells: readonly Smell[]): SmellFinding[] {
  return smells
    .map((smell) => ({ rule: smell.kind, target: repoTarget(scope, smell), value: smell.value }))
    .sort(compareFindings);
}

// The rules this graph measured: every `syntax` rule, and the `edges` rules only when the edge
// pass ran. A rule the run did not measure has no smells in it, which is not the same as none.
export function measuredRules(graph: Graph): ReadonlySet<SmellKind> {
  const edges = graph.provenance.pass === "edges";
  return new Set(KINDS.filter((kind) => edges || RULES[kind].measuredBy === "syntax"));
}

export function needsEdges(gated: readonly SmellKind[]): boolean {
  return gated.some((kind) => RULES[kind].measuredBy === "edges");
}

function inReach(scope: string, target: string): boolean {
  return scope === "." || target === scope || target.startsWith(`${scope}/`);
}

// A recorded smell whose measure moved: `recorded` is the ledger's value, `measured` this run's.
export type SmellChange = {
  readonly rule: SmellKind;
  readonly target: string;
  readonly recorded: number;
  readonly measured: number;
};

// What one run found against the ledger. Only entries in the analyzed scope, of a gated rule and
// of a rule this run measured, are in play: `pruned` are those whose smell is gone, `lowered`
// those that improved (both written back in `kept`), `worsened` those that grew past their
// recorded value. Every other entry is kept as it is.
export type SmellReconciliation = {
  readonly scope: string;
  readonly gated: readonly SmellKind[];
  readonly unrecorded: readonly SmellFinding[];
  readonly worsened: readonly SmellChange[];
  readonly lowered: readonly SmellChange[];
  readonly pruned: readonly SmellLedgerEntry[];
  readonly kept: SmellLedger;
};

export function reconcileSmells(
  ledger: SmellLedger,
  scope: string,
  findings: readonly SmellFinding[],
  measured: ReadonlySet<SmellKind>,
): SmellReconciliation {
  const inPlay = (rule: SmellKind) => ledger.gated.includes(rule) && measured.has(rule);
  const found = new Map(
    findings
      .filter((finding) => inPlay(finding.rule))
      .map((finding) => [smellKey(finding), finding]),
  );
  const recorded = new Set(ledger.entries.map(smellKey));
  const worsened: SmellChange[] = [];
  const lowered: SmellChange[] = [];
  const pruned: SmellLedgerEntry[] = [];
  const kept: SmellLedgerEntry[] = [];
  for (const entry of ledger.entries) {
    if (!inPlay(entry.rule) || !inReach(scope, entry.target)) {
      kept.push(entry);
      continue;
    }
    const finding = found.get(smellKey(entry));
    if (finding === undefined) {
      pruned.push(entry);
      continue;
    }
    const change = {
      rule: entry.rule,
      target: entry.target,
      recorded: entry.value,
      measured: finding.value,
    };
    if (finding.value > entry.value) worsened.push(change);
    if (finding.value < entry.value) lowered.push(change);
    kept.push({ ...entry, value: Math.min(entry.value, finding.value) });
  }
  return {
    scope,
    gated: ledger.gated,
    unrecorded: [...found.values()].filter((finding) => !recorded.has(smellKey(finding))),
    worsened,
    lowered,
    pruned,
    kept: smellLedgerOf(ledger.gated, kept),
  };
}

// The ledger after an accept: every unrecorded smell added and every worsened one raised to its
// measured value, each carrying `reason`.
export function withAcceptedSmells(result: SmellReconciliation, reason: string): SmellLedger {
  const raised = new Map(result.worsened.map((change) => [smellKey(change), change.measured]));
  const entries = result.kept.entries.map((entry) => {
    const measured = raised.get(smellKey(entry));
    return measured === undefined ? entry : { ...entry, value: measured, reason };
  });
  const added = result.unrecorded.map((finding) => ({ ...finding, reason }));
  return smellLedgerOf(result.kept.gated, [...entries, ...added]);
}
