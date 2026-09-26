import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  canonicalJson,
  type Stage,
  type StageArtifact,
  type StageInput,
} from "./artifact.js";
import type { ChoiceQuestion } from "./ask.js";
import type { Fact, SourceSpan } from "./fact.js";
import {
  type GateItem,
  type GateOptions,
  gateAll,
  type HumanQueue,
} from "./gate.js";
import {
  atomTerms,
  freeIdentifiers,
  type LoweredBranch,
  lowerStage,
  outcomeTerms,
  renderAtom,
  renderOutcome,
} from "./lower.js";

/** Where the lexicon lives: beside `structure-sweep.config.json`. */
export const DEFAULT_LEXICON_FILE = "structure-sweep.lexicon.json";

/** What a lexicon concept can be. Closed: a kind outside it is refused, never read as a new one. */
export const CONCEPT_KINDS = [
  "flag",
  "entitlement",
  "role",
  "plan",
  "setting",
  "env",
] as const;

export type ConceptKind = (typeof CONCEPT_KINDS)[number];

const Identifier = z
  .string()
  .regex(
    /^[A-Za-z_$][\w$]*(\.[A-Za-z_$#][\w$]*)*$/,
    "an identifier is a name or a dotted member path",
  );

export const LexiconEntry = z.strictObject({
  kind: z.enum(CONCEPT_KINDS, {
    error: `kind is one of ${CONCEPT_KINDS.join(", ")}`,
  }),
  /** The concept's name, shared by every identifier that reads it. */
  concept: z.string().trim().min(1, "a concept has a name"),
});

export type LexiconEntry = z.infer<typeof LexiconEntry>;

export const LexiconConfig = z.strictObject({
  /** Identifier (a callee name or member path) → the concept it reads. */
  entries: z.record(Identifier, LexiconEntry),
});

export type LexiconConfig = z.infer<typeof LexiconConfig>;

/** A parsed lexicon. `fingerprint` changes whenever an entry does, and keys stage 3's artifacts. */
export interface Lexicon extends LexiconConfig {
  readonly fingerprint: string;
}

export class LexiconError extends Error {}

export function parseLexicon(raw: unknown, source = "lexicon"): Lexicon {
  const parsed = LexiconConfig.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) =>
        `  ${i.path.length === 0 ? "(root)" : i.path.join(".")}: ${i.message}`,
    );
    throw new LexiconError(
      `${source} is not a valid lexicon:\n${issues.join("\n")}`,
    );
  }
  const fingerprint = createHash("sha256")
    .update(canonicalJson(parsed.data))
    .digest("hex")
    .slice(0, 16);
  return { ...parsed.data, fingerprint };
}

export function loadLexicon(path: string): Lexicon {
  if (!existsSync(path))
    throw new LexiconError(`no lexicon at ${path}; write one (see the README)`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new LexiconError(
      `${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseLexicon(raw, path);
}

// ── stage 3: resolution ───────────────────────────────────────────────────

/** Where in a branch an identifier was read: its path condition, its outcome, or a binding one of those uses. */
export type Site = "condition" | "outcome" | "binding";

/** One identifier of a branch, and the concept the lexicon maps it to, if any. Nothing is guessed. */
export type Resolution =
  | {
      readonly _tag: "resolved";
      readonly identifier: string;
      readonly site: Site;
      readonly kind: ConceptKind;
      readonly concept: string;
    }
  | {
      readonly _tag: "unresolved";
      readonly identifier: string;
      readonly site: Site;
    };

export interface ResolvedBranch {
  readonly branch: LoweredBranch;
  readonly resolutions: readonly Resolution[];
}

/** Map every free identifier of a branch to its lexicon concept, by exact match, with no Jev call. */
export function resolveBranch(
  branch: LoweredBranch,
  lexicon: LexiconConfig,
): ResolvedBranch {
  const sites: [Site, readonly string[]][] = [
    ["condition", branch.path.flatMap(atomTerms).flatMap(freeIdentifiers)],
    ["outcome", outcomeTerms(branch.outcome).flatMap(freeIdentifiers)],
    ["binding", branch.bindings.flatMap((b) => freeIdentifiers(b.init))],
  ];
  const seen = new Set<string>();
  const resolutions: Resolution[] = [];
  for (const [site, identifiers] of sites)
    for (const identifier of identifiers) {
      if (seen.has(`${site} ${identifier}`)) continue;
      seen.add(`${site} ${identifier}`);
      const entry = Object.hasOwn(lexicon.entries, identifier)
        ? lexicon.entries[identifier]
        : undefined;
      resolutions.push(
        entry === undefined
          ? { _tag: "unresolved", identifier, site }
          : { _tag: "resolved", identifier, site, ...entry },
      );
    }
  return { branch, resolutions };
}

/**
 * A file's stage-3 input: the lexicon, fingerprint included, as the content, and the file's stage-2
 * artifact. Editing the lexicon changes this key and not stage 2's.
 */
export function resolveInput(
  lexicon: Lexicon,
  lowered: StageArtifact<LoweredBranch>,
): StageInput {
  return {
    content: canonicalJson({
      fingerprint: lexicon.fingerprint,
      entries: lexicon.entries,
    }),
    artifacts: [lowered],
  };
}

/** Stage 3: every lowered branch with its identifiers resolved against the lexicon. */
export const resolveStage: Stage<ResolvedBranch> = {
  name: "resolve",
  version: "1",
  run: async (input) => {
    const { entries } = z
      .object({ entries: LexiconConfig.shape.entries })
      .parse(JSON.parse(input.content));
    const [lowered, ...rest] = input.artifacts;
    if (
      lowered === undefined ||
      rest.length > 0 ||
      lowered.stage !== lowerStage.name
    )
      throw new TypeError(
        `stage 3 reads exactly one "${lowerStage.name}" artifact`,
      );
    return (lowered as StageArtifact<LoweredBranch>).facts.map(
      (fact): Fact<ResolvedBranch> =>
        fact.value._tag === "known"
          ? {
              ...fact,
              value: {
                ...fact.value,
                value: resolveBranch(fact.value.value, { entries }),
              },
            }
          : { ...fact, value: fact.value },
    );
  },
};

// ── proposing entries ─────────────────────────────────────────────────────

export const LEXICON_LABELS = [...CONCEPT_KINDS, "none"] as const;

export type LexiconLabel = (typeof LEXICON_LABELS)[number];

/** The question `proposeLexicon` asks about one unresolved identifier. */
export const lexiconQuestion: ChoiceQuestion<LexiconLabel> = {
  type: "choice",
  instructions:
    "state.identifier is a name or member path read by the branches in state.uses. Say which kind of concept it reads, or none.",
  criteria: {
    flag: "A feature or kill switch that turns a behaviour on or off, including a switch that enforces a limit or check.",
    entitlement:
      "Whether an account, org or user has been granted a capability or add-on.",
    role: "Who the actor is in the organisation: owner, admin, member, guest.",
    plan: "The subscription or pricing tier and what it includes.",
    setting:
      "A value an operator or customer configures, such as a limit, a region or a preference.",
    env: "A deployment or runtime environment value, such as an environment variable or the stage.",
    none: "It reads none of those: a utility, a data access or a library call.",
  },
};

export interface UnresolvedIdentifier {
  readonly identifier: string;
  readonly count: number;
  /** The first branch that reads it. */
  readonly span: SourceSpan;
  /** The branches that read it, as text, first five. */
  readonly uses: readonly string[];
}

const USES_SHOWN = 5;

/** Every unresolved identifier across resolved branches, most frequent first. */
export function unresolvedIdentifiers(
  resolved: readonly Fact<ResolvedBranch>[],
): readonly UnresolvedIdentifier[] {
  const byIdentifier = new Map<
    string,
    { count: number; span: SourceSpan; uses: string[] }
  >();
  for (const fact of resolved) {
    if (fact.value._tag !== "known") continue;
    const { branch, resolutions } = fact.value.value;
    const text = `${branch.path.map(renderAtom).join(" ∧ ") || "⊤"} ⇒ ${renderOutcome(branch.outcome)}`;
    for (const resolution of resolutions) {
      if (resolution._tag !== "unresolved") continue;
      const seen = byIdentifier.get(resolution.identifier) ?? {
        count: 0,
        span: fact.span,
        uses: [],
      };
      seen.count += 1;
      if (seen.uses.length < USES_SHOWN && !seen.uses.includes(text))
        seen.uses.push(text);
      byIdentifier.set(resolution.identifier, seen);
    }
  }
  return [...byIdentifier]
    .map(([identifier, seen]) => ({ identifier, ...seen }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        (a.identifier < b.identifier
          ? -1
          : a.identifier > b.identifier
            ? 1
            : 0),
    );
}

/** Entries Jev proposed and the gate promoted, for a human to review. It is never the reviewed lexicon. */
export interface LexiconDraft {
  readonly entries: Readonly<Record<string, LexiconEntry>>;
  /** The identifiers the gate abstained on. */
  readonly queue: HumanQueue<LexiconLabel>;
}

export interface ProposeLexiconOptions {
  readonly resolved: readonly Fact<ResolvedBranch>[];
  /** How many of the most frequent unresolved identifiers to ask about. */
  readonly limit: number;
  readonly gate: GateOptions<LexiconLabel>;
}

/**
 * Ask the gate about the most frequent unresolved identifiers and draft an entry for each promoted
 * concept kind. The concept name is the identifier itself, for the reviewer to rename or merge.
 */
export async function proposeLexicon(
  options: ProposeLexiconOptions,
): Promise<LexiconDraft> {
  if (!Number.isInteger(options.limit) || options.limit < 0)
    throw new RangeError(`limit is a whole number, not ${options.limit}`);
  const candidates = unresolvedIdentifiers(options.resolved).slice(
    0,
    options.limit,
  );
  const items: GateItem[] = candidates.map((c) => ({
    id: c.identifier,
    span: c.span,
    state: { identifier: c.identifier, uses: [...c.uses] },
  }));
  const gated = await gateAll("lexicon", items, options.gate);
  const entries: Record<string, LexiconEntry> = {};
  for (const fact of gated.facts)
    if (fact.value._tag === "known" && fact.value.value !== "none")
      entries[fact.id] = { kind: fact.value.value, concept: fact.id };
  return { entries, queue: gated.queue };
}

/** Where a draft for `lexiconPath` is written: beside it, never over it. */
export const draftPathOf = (lexiconPath: string): string =>
  join(
    dirname(lexiconPath),
    `${basename(lexiconPath).replace(/\.json$/, "")}.draft.json`,
  );

/** Write a draft beside the reviewed lexicon, returning the path it wrote. */
export function writeLexiconDraft(
  lexiconPath: string,
  draft: LexiconDraft,
): string {
  const path = draftPathOf(lexiconPath);
  writeFileSync(
    path,
    `${JSON.stringify({ entries: draft.entries }, null, 2)}\n`,
  );
  return path;
}
