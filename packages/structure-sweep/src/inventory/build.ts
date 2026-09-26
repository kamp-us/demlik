import { createHash } from "node:crypto";
import { dirname } from "node:path/posix";
import type { GroupsFile } from "../groups/file.js";
import { canonicalJson } from "../lowering/artifact.js";
import { clusterStatus } from "../lowering/group.js";
import { actionFor, pairGroups } from "../pairs/report.js";
import { anyGlob } from "./glob.js";
import {
  type ConsolidateInput,
  type GraphFunctionRow,
  type GraphInput,
  INPUT_FLAGS,
  type PairInput,
  type Source,
  type UnreachableInput,
} from "./inputs.js";
import {
  DEFAULT_GENERIC_NAMES,
  LEVER_ORDER,
  LEVERS,
  type Lever,
  SAME_DECISION_FLOOR,
  SCOPE_DEPTH,
  SHARED_HELPER_FLOOR,
} from "./levers.js";

/** Lines `startLine` to `endLine` of `file`, both inclusive. */
export interface Span {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** One deletable or mergeable thing, with where it is and what to do about it. */
export interface InventoryEntry {
  /** `<letter>-<hash>` of the entry's lever, subject, spans and signals: the same content, the same id. */
  readonly id: string;
  readonly lever: Lever;
  /** What the entry is about: a name, a scope, a family. */
  readonly subject: string;
  /** The source signal(s) behind the entry, each `<kind>:<value>`. */
  readonly signals: readonly string[];
  readonly spans: readonly Span[];
  /** The weakest verdict confidence behind the entry; `null` where the source judges nothing. */
  readonly confidence: number | null;
  /** What the action removes, counted in the lever's `unit`. */
  readonly deletions: number;
  readonly action: string;
}

/** Whether a lever was built, or skipped for want of its input, and which input that was. */
export type LeverStatus =
  | {
      readonly lever: Lever;
      readonly state: "built";
      readonly input: string;
      readonly entries: number;
    }
  | {
      readonly lever: Lever;
      readonly state: "skipped";
      readonly flag: string;
      /** The path looked at; `null` when the flag was not given. */
      readonly path: string | null;
      readonly reason: string;
    };

export interface Inventory {
  readonly version: 1;
  readonly levers: readonly LeverStatus[];
  /** Ordered by lever, then by deletions, biggest first. */
  readonly entries: readonly InventoryEntry[];
}

export interface InventoryInputs {
  readonly unreachable: Source<UnreachableInput>;
  readonly graph: Source<GraphInput>;
  readonly consolidate: Source<ConsolidateInput>;
  readonly pairs: Source<readonly PairInput[]>;
  readonly groups: Source<GroupsFile>;
}

export interface InventoryOptions {
  /** Globs whose files no tiny-file merge may list. */
  readonly exclude?: readonly string[];
  /**
   * A file's line count at `consolidate.json`'s ref, for a whole-file span's end line; `undefined`
   * falls back to the non-blank count the plan carries.
   */
  readonly fileLines?: (path: string) => number | undefined;
}

/** What one lever answers: its entries, or why it could not be built. */
type LeverResult =
  | {
      readonly _tag: "built";
      readonly input: string;
      readonly entries: readonly Draft[];
    }
  | {
      readonly _tag: "skipped";
      readonly flag: string;
      readonly path: string | null;
      readonly reason: string;
    };

type Draft = Omit<InventoryEntry, "id" | "lever">;

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const spanLines = (s: Span) => s.endLine - s.startLine + 1;

const bySpan = (a: Span, b: Span) =>
  byText(a.file, b.file) || a.startLine - b.startLine || a.endLine - b.endLine;

/** Every span once, in file then line order. */
const uniqueSpans = (spans: readonly Span[]): Span[] =>
  [
    ...new Map(
      spans.map((s) => [`${s.file}\0${s.startLine}\0${s.endLine}`, s]),
    ).values(),
  ].sort(bySpan);

/** The lines that go when every copy but the largest is removed. */
const allButLargest = (spans: readonly Span[]) => {
  const sizes = spans.map(spanLines);
  return sizes.reduce((sum, n) => sum + n, 0) - Math.max(0, ...sizes);
};

type Missing = Extract<Source<unknown>, { readonly _tag: "missing" }>;

const skipped = (source: Missing): LeverResult => ({
  _tag: "skipped",
  flag: source.flag,
  path: source.path,
  reason: source.path === null ? "not given" : "no such file",
});

// ── A: dead exports ────────────────────────────────────────────────────────

function deadExports(
  unreachable: Source<UnreachableInput>,
  graph: Source<GraphInput>,
): LeverResult {
  if (unreachable._tag === "missing") return skipped(unreachable);
  const functions = [
    ...(graph._tag === "read" ? graph.value.functions : []),
    ...unreachable.value.functions,
  ];
  const endOf = new Map(functions.map((f) => [f.id, f.endLine]));
  return {
    _tag: "built",
    input: unreachable.path,
    entries: unreachable.value.unreachable.map((u): Draft => {
      const span = {
        file: u.file,
        startLine: u.startLine,
        endLine: Math.max(u.startLine, endOf.get(u.id) ?? u.startLine),
      };
      const testOnly = u.category === "only-called-from-tests";
      return {
        subject: u.id,
        signals: [
          `unreachable:${u.category}`,
          ...[...u.testReferences]
            .sort(byText)
            .map((f) => `test-reference:${f}`),
        ],
        spans: [span],
        confidence: null,
        deletions: spanLines(span),
        action: testOnly
          ? "delete the export and the tests that alone reach it"
          : "delete the export",
      };
    }),
  };
}

// ── B: tiny-file merges ────────────────────────────────────────────────────

function tinyFileMerges(
  consolidate: Source<ConsolidateInput>,
  options: InventoryOptions,
): LeverResult {
  if (consolidate._tag === "missing") return skipped(consolidate);
  const plan = consolidate.value;
  if (plan.merge === null)
    return {
      _tag: "skipped",
      flag: INPUT_FLAGS.consolidate,
      path: consolidate.path,
      reason: "consolidate ran without sweep verdicts, so it proposed no merge",
    };
  const excluded = anyGlob(options.exclude ?? []);
  const entries = plan.merge.flatMap((p): Draft[] => {
    const files = p.files.filter((f) => !excluded(f.path));
    if (files.length < plan.minCluster) return [];
    return [
      {
        subject: `${p.scope} · ${p.feature} · ${p.role}`,
        signals: ["consolidate:merge"],
        spans: uniqueSpans(
          files.map((f) => ({
            file: f.path,
            startLine: 1,
            endLine: Math.max(1, options.fileLines?.(f.path) ?? f.lines),
          })),
        ),
        confidence: null,
        deletions: files.length - 1,
        action: `merge ${files.length} files into one module`,
      },
    ];
  });
  return { _tag: "built", input: consolidate.path, entries };
}

// ── C and D: same-decision groups and shared-helper families ─────────────

const sideSpan = (fn: PairInput["a"]): Span => ({
  file: fn.path,
  startLine: fn.lines[0],
  endLine: Math.max(fn.lines[0], fn.lines[1]),
});

/** The spans and weakest confidence of a set of pairs. */
function pairsDraft(
  subject: string,
  verdict: "same_decision" | "shared_helper",
  pairs: readonly PairInput[],
): Draft {
  const spans = uniqueSpans(
    pairs.flatMap((p) => [sideSpan(p.a), sideSpan(p.b)]),
  );
  return {
    subject,
    signals: [
      `pairs:${verdict}`,
      ...[...new Set(pairs.map((p) => `pair:${p.id}`))].sort(byText),
    ],
    spans,
    confidence: Math.min(...pairs.map((p) => p.answers.verdict.confidence)),
    deletions: allButLargest(spans),
    action: actionFor(verdict),
  };
}

const atLeast = (
  rows: readonly PairInput[],
  verdict: "same_decision" | "shared_helper",
  floor: number,
) =>
  rows.filter(
    (r) =>
      r.answers.verdict.choice === verdict &&
      r.answers.verdict.confidence >= floor,
  );

function sameDecision(pairs: Source<readonly PairInput[]>): LeverResult {
  if (pairs._tag === "missing") return skipped(pairs);
  const rows = atLeast(pairs.value, "same_decision", SAME_DECISION_FLOOR);
  return {
    _tag: "built",
    input: pairs.path,
    entries: pairGroups(rows, "same_decision").map((g) =>
      pairsDraft(`${g.members.length} functions`, "same_decision", g.pairs),
    ),
  };
}

/** A function's name without the `#<n>` code-graph appends to a repeated one. */
const bareName = (fn: PairInput["a"]) => fn.function.replace(/#\d+$/, "");

function sharedHelper(pairs: Source<readonly PairInput[]>): LeverResult {
  if (pairs._tag === "missing") return skipped(pairs);
  const families = new Map<string, PairInput[]>();
  for (const row of atLeast(
    pairs.value,
    "shared_helper",
    SHARED_HELPER_FLOOR,
  )) {
    const name = [...new Set([bareName(row.a), bareName(row.b)])]
      .sort(byText)
      .join(" / ");
    families.set(name, [...(families.get(name) ?? []), row]);
  }
  return {
    _tag: "built",
    input: pairs.path,
    entries: [...families].map(([name, rows]) =>
      pairsDraft(name, "shared_helper", rows),
    ),
  };
}

// ── E: exported-name twins ────────────────────────────────────────────────

/** The first `SCOPE_DEPTH` directories of a file: the scope a twin must differ in. */
export function topLevelScope(file: string): string {
  const dir = dirname(file);
  return dir === "." ? "." : dir.split("/").slice(0, SCOPE_DEPTH).join("/");
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function nameTwins(graph: Source<GraphInput>): LeverResult {
  if (graph._tag === "missing") return skipped(graph);
  const generic = new Set(DEFAULT_GENERIC_NAMES);
  const byName = new Map<string, GraphFunctionRow[]>();
  for (const fn of graph.value.functions) {
    if (!fn.isExported || fn.isTest) continue;
    if (!IDENTIFIER.test(fn.name) || generic.has(fn.name)) continue;
    byName.set(fn.name, [...(byName.get(fn.name) ?? []), fn]);
  }
  const entries = [...byName].flatMap(([name, fns]): Draft[] => {
    const scopes = [...new Set(fns.map((f) => topLevelScope(f.file)))].sort(
      byText,
    );
    if (scopes.length < 2) return [];
    const spans = uniqueSpans(
      fns.map((f) => ({
        file: f.file,
        startLine: f.startLine,
        endLine: Math.max(f.startLine, f.endLine),
      })),
    );
    return [
      {
        subject: name,
        signals: ["graph:exported-name", ...scopes.map((s) => `scope:${s}`)],
        spans,
        confidence: null,
        deletions: allButLargest(spans),
        action: "merge into one shared export, or rename the ones that differ",
      },
    ];
  });
  return { _tag: "built", input: graph.path, entries };
}

// ── F: rule groups ────────────────────────────────────────────────────────

function ruleGroups(groups: Source<GroupsFile>): LeverResult {
  if (groups._tag === "missing") return skipped(groups);
  const entries = groups.value.confirmed.facts.flatMap((fact): Draft[] => {
    if (fact.value._tag !== "known") return [];
    const record = fact.value.value;
    if (clusterStatus(record) !== "confirmed") return [];
    const spans = uniqueSpans(record.cluster.members.map((m) => m.span));
    return [
      {
        subject: record.cluster.id,
        signals: [
          "groups:same-rule",
          `group:${record.cluster.id}`,
          `basis:${record.cluster.basis._tag}`,
        ],
        spans,
        confidence: record.answer.confidence,
        deletions: allButLargest(spans),
        action: "collapse the branches into one rule",
      },
    ];
  });
  return { _tag: "built", input: groups.path, entries };
}

// ── assembly ──────────────────────────────────────────────────────────────

function entryId(lever: Lever, draft: Draft): string {
  const hash = createHash("sha256")
    .update(
      canonicalJson({
        lever,
        subject: draft.subject,
        spans: draft.spans,
        signals: draft.signals,
      }),
    )
    .digest("hex")
    .slice(0, 12);
  return `${LEVERS[lever].letter}-${hash}`;
}

const byDeletions = (a: InventoryEntry, b: InventoryEntry) =>
  b.deletions - a.deletions ||
  bySpan(a.spans[0] as Span, b.spans[0] as Span) ||
  byText(a.id, b.id);

/**
 * The consolidation inventory: every lever built from the inputs it reads, a lever whose input is
 * missing recorded as skipped. Pure over its inputs: the same inputs build the same inventory.
 */
export function buildInventory(
  inputs: InventoryInputs,
  options: InventoryOptions = {},
): Inventory {
  const results: Record<Lever, LeverResult> = {
    "dead-export": deadExports(inputs.unreachable, inputs.graph),
    "tiny-file-merge": tinyFileMerges(inputs.consolidate, options),
    "same-decision": sameDecision(inputs.pairs),
    "shared-helper": sharedHelper(inputs.pairs),
    "name-twin": nameTwins(inputs.graph),
    "rule-group": ruleGroups(inputs.groups),
  };
  const levers: LeverStatus[] = [];
  const entries: InventoryEntry[] = [];
  for (const lever of LEVER_ORDER) {
    const result = results[lever];
    if (result._tag === "skipped") {
      const { _tag, ...why } = result;
      levers.push({ lever, state: "skipped", ...why });
      continue;
    }
    const built = result.entries
      .filter((d) => d.spans.length > 0)
      .map((d): InventoryEntry => ({ id: entryId(lever, d), lever, ...d }))
      .sort(byDeletions);
    levers.push({
      lever,
      state: "built",
      input: result.input,
      entries: built.length,
    });
    entries.push(...built);
  }
  return { version: 1, levers, entries };
}
