import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JevRequest, JevUsage } from "@demlik/tea/jev";
import { type JevClient, pool } from "../jev.js";
import type { LoweringGraph } from "../lowering/lower.js";
import {
  type AnchorJev,
  anchorAnswers,
  anchorQuestions,
  anchorRef,
  isAnchorAnswers,
} from "./anchor.js";
import {
  anchorMenus,
  DEFAULT_MAX_PARTNERS,
  functionKey,
  type Menu,
  partnerOf,
} from "./cap.js";
import { loadPairs, type Pair, type PairFunction } from "./collapse.js";
import { type PairQuestions, pairQuestions } from "./questions.js";
import {
  isAnswered,
  type JudgedFunction,
  type PairRow,
  type SkippedPair,
} from "./report.js";

/**
 * `anchor` asks one question per anchor function over its capped partners plus `none`; `pairwise`
 * asks the three-way verdict once per pair, for gold-set evaluation.
 */
export type PairsMode = "anchor" | "pairwise";

export const DEFAULT_PAIRS_MODE: PairsMode = "anchor";

/** The client a run asks through, which is also what picks its mode. */
export type PairsJev =
  | { readonly mode: "anchor"; readonly ask: AnchorJev }
  | { readonly mode: "pairwise"; readonly ask: JevClient<PairQuestions> };

export interface PairTarget {
  /** The folder code-graph ran on, repo-relative; the collapse report's paths are relative to it. */
  readonly scope: string;
  /** The `code-graph <scope> --collapse --json` output. */
  readonly collapsePath: string;
}

/** What decides which pairs are asked and what each is shown: every option but the mode and client. */
export interface PairsSelection {
  readonly root: string;
  readonly ref: string;
  readonly targets: readonly PairTarget[];
  readonly outPath: string;
  /** Show Jev each function's name and source only, never its file path. */
  readonly redact?: boolean;
  /** The most partners any one anchor is judged against (default `DEFAULT_MAX_PARTNERS`). */
  readonly maxPartners?: number;
  /**
   * The code-graph `--graph` nodes for the targets' scope. With them, each function is sent as its
   * stage-2 lowered body where stage 2 lowers the whole function, and as its source otherwise.
   */
  readonly graph?: LoweringGraph;
  readonly log?: (line: string) => void;
}

export interface PairsOptions extends PairsSelection {
  readonly jev: PairsJev;
  readonly concurrency?: number;
}

export interface Spent {
  readonly input: number;
  readonly output: number;
}

/** How many functions sent to Jev went out as a lowered body, of all functions sent. */
export interface Bodies {
  readonly lowered: number;
  readonly sides: number;
}

export interface PairsResult {
  readonly rows: readonly PairRow[];
  readonly spent: Spent;
  /** Every pair the partner cap left unasked, in collapse-report order per scope. */
  readonly skipped: readonly SkippedPair[];
  readonly bodies: Bodies;
}

const located = ({
  path,
  function: name,
  lines,
}: PairFunction): JudgedFunction => ({
  path,
  function: name,
  lines,
});

/** One function as Jev sees it: redacted, the path is gone and only the code is left to judge. */
const shown = (fn: PairFunction, redact: boolean) => {
  const body =
    fn.lowered === undefined ? { source: fn.source } : { lowered: fn.lowered };
  return redact
    ? { function: fn.function, ...body }
    : { path: fn.path, function: fn.function, ...body };
};

const pairState = (pair: Pair, redact: boolean) => ({
  a: shown(pair.a, redact),
  b: shown(pair.b, redact),
  signals: pair.signals,
});

/** An anchor's question state: the anchor sent once, then each candidate partner under its ref. */
const anchorState = (menu: Menu, redact: boolean) => ({
  anchor: shown(menu.anchor, redact),
  candidates: menu.candidates.map((candidate, i) => ({
    ref: anchorRef(i),
    ...shown(partnerOf(candidate), redact),
    signals: candidate.pair.signals,
  })),
});

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/** A hash of the lowered bodies a pair sends; `undefined` when both sides go out as source. */
function loweredHash(pair: Pair): string | undefined {
  if (pair.a.lowered === undefined && pair.b.lowered === undefined)
    return undefined;
  return hash([pair.a.lowered ?? null, pair.b.lowered ?? null]);
}

/**
 * How one row's answer was asked: the question (mode, and for an anchor the whole menu it was
 * asked over), the redaction and the lowered bodies. Every field is part of the cache key.
 */
type Send = {
  readonly redacted: boolean;
  readonly lowered: string | undefined;
} & (
  | { readonly mode: "pairwise" }
  | { readonly mode: "anchor"; readonly menu: string }
);

/**
 * A cached answer serves a pair only when it was asked the same way, so no answer crosses between
 * modes, anchor menus, redacted and plain runs, or lowered and raw sends. A plain raw pairwise row
 * keeps its bare `id` key.
 */
const cacheKey = (id: string, send: Send) =>
  [
    id,
    send.mode === "anchor" ? `anchor ${send.menu}` : "",
    send.redacted ? "redacted" : "",
    send.lowered ? `lowered ${send.lowered}` : "",
  ]
    .filter((part) => part !== "")
    .join(" ");

const sendOf = (row: PairRow): Send => {
  const base = { redacted: row.redacted === true, lowered: row.lowered };
  return isAnchorAnswers(row.answers)
    ? { ...base, mode: "anchor", menu: row.answers.partner.menu }
    : { ...base, mode: "pairwise" };
};

interface Ledger {
  /** Every answered row on file, under its cache key. An unanswered row is asked again. */
  readonly cache: ReadonlyMap<string, PairRow>;
  readonly judged: Map<string, PairRow>;
  rows(): PairRow[];
  save(): void;
}

function openLedger(outPath: string, rerun: ReadonlySet<string>): Ledger {
  const previous: PairRow[] = existsSync(outPath)
    ? JSON.parse(readFileSync(outPath, "utf8"))
    : [];
  const kept = previous.filter((r) => !rerun.has(r.scope));
  const judged = new Map<string, PairRow>();
  const rows = () =>
    [...kept, ...judged.values()].sort(
      (x, y) => x.scope.localeCompare(y.scope) || x.id.localeCompare(y.id),
    );
  return {
    cache: new Map(
      previous.filter(isAnswered).map((r) => [cacheKey(r.id, sendOf(r)), r]),
    ),
    judged,
    rows,
    save: () => {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${JSON.stringify(rows(), null, 1)}\n`);
    },
  };
}

/** A cached row moved onto the pair as this run read it: its scope, locations and signals. */
const relocated = (hit: PairRow, scope: string, pair: Pair): PairRow => ({
  ...hit,
  scope,
  a: located(pair.a),
  b: located(pair.b),
  signals: pair.signals,
});

// ── the questions a run asks ──────────────────────────────────────────────

/**
 * One Jev call a run would make, in either mode: the pairs it answers, the request it sends, and
 * the rows those pairs get from its answer. `cached` holds those rows already on file when every
 * pair has one, and then the call is not made.
 */
interface Question {
  readonly pairs: readonly Pair[];
  readonly request: (model: string) => JevRequest;
  readonly cached: readonly PairRow[] | undefined;
  readonly ask: (
    jev: PairsJev,
  ) => Promise<{ rows: PairRow[]; usage: JevUsage }>;
}

function rowOf(
  scope: string,
  pair: Pair,
  send: Send,
  { answers, model, usage }: Pick<PairRow, "answers" | "model" | "usage">,
): PairRow {
  return {
    id: pair.id,
    scope,
    a: located(pair.a),
    b: located(pair.b),
    signals: pair.signals,
    graphConfidence: pair.graphConfidence,
    ...(send.redacted ? { redacted: true as const } : {}),
    ...(send.lowered === undefined ? {} : { lowered: send.lowered }),
    answers,
    model,
    usage,
  };
}

function pairwiseQuestion(
  ledger: Ledger,
  scope: string,
  pair: Pair,
  redact: boolean,
): Question {
  const send: Send = {
    mode: "pairwise",
    redacted: redact,
    lowered: loweredHash(pair),
  };
  const state = pairState(pair, redact);
  const hit = ledger.cache.get(cacheKey(pair.id, send));
  return {
    pairs: [pair],
    request: (model) => ({ state, model, questions: pairQuestions }),
    cached: hit === undefined ? undefined : [relocated(hit, scope, pair)],
    ask: async (jev) => {
      if (jev.mode !== "pairwise") throw new TypeError("not a pairwise client");
      const ok = await jev.ask(state);
      return {
        rows: [rowOf(scope, pair, send, ok)],
        usage: ok.usage,
      };
    },
  };
}

function anchorQuestion(
  ledger: Ledger,
  scope: string,
  menu: Menu,
  redact: boolean,
): Question {
  const state = anchorState(menu, redact);
  const questions = anchorQuestions(menu.candidates.length);
  const menuHash = hash(state);
  const sent = menu.candidates.map((candidate, i) => ({
    candidate,
    ref: anchorRef(i),
    send: {
      mode: "anchor",
      menu: menuHash,
      redacted: redact,
      lowered: loweredHash(candidate.pair),
    } satisfies Send,
  }));
  const hits = sent.map(({ candidate, send }) => {
    const hit = ledger.cache.get(cacheKey(candidate.pair.id, send));
    if (hit === undefined || !isAnchorAnswers(hit.answers)) return undefined;
    // The pair's sides can come back swapped; the anchor is whichever side this menu's anchor is.
    return {
      ...relocated(hit, scope, candidate.pair),
      answers: {
        ...hit.answers,
        partner: { ...hit.answers.partner, anchor: candidate.anchor },
      },
    };
  });
  const cached = hits.every((row) => row !== undefined)
    ? (hits as PairRow[])
    : undefined;
  return {
    pairs: menu.candidates.map((c) => c.pair),
    request: (model) => ({ state, model, questions }),
    cached,
    ask: async (jev) => {
      if (jev.mode !== "anchor") throw new TypeError("not an anchor client");
      const ok = await jev.ask(questions, state);
      return {
        rows: sent.map(({ candidate, ref, send }) =>
          rowOf(scope, candidate.pair, send, {
            answers: anchorAnswers(ok.answers, {
              anchor: candidate.anchor,
              ref,
              menu: menuHash,
            }),
            model: ok.model,
            usage: ok.usage,
          }),
        ),
        usage: ok.usage,
      };
    },
  };
}

/** One scope's collapse pairs, dealt to anchors under the partner cap, and the questions to ask. */
interface ScopeQuestions {
  readonly scope: string;
  readonly candidates: readonly Pair[];
  readonly anchors: number;
  readonly skipped: readonly Pair[];
  readonly questions: readonly Question[];
  readonly bodies: Bodies;
}

function questionsFor(
  options: PairsSelection,
  mode: PairsMode,
  ledger: Ledger,
  { scope, collapsePath }: PairTarget,
): ScopeQuestions {
  const redact = options.redact === true;
  const candidates = loadPairs(
    options.root,
    options.ref,
    scope,
    collapsePath,
    options.log,
    options.graph,
  );
  const { menus, skipped } = anchorMenus(
    candidates,
    options.maxPartners ?? DEFAULT_MAX_PARTNERS,
  );
  const sent: PairFunction[] =
    mode === "anchor"
      ? menus.flatMap((m) => [m.anchor, ...m.candidates.map(partnerOf)])
      : menus.flatMap((m) => m.candidates.flatMap((c) => [c.pair.a, c.pair.b]));
  // Pairwise asks the kept pairs in the order the collapse report lists them.
  const kept = new Set(menus.flatMap((m) => m.candidates.map((c) => c.pair)));
  const questions =
    mode === "anchor"
      ? menus.map((menu) => anchorQuestion(ledger, scope, menu, redact))
      : candidates
          .filter((pair) => kept.has(pair))
          .map((pair) => pairwiseQuestion(ledger, scope, pair, redact));
  return {
    scope,
    candidates,
    anchors: menus.length,
    skipped,
    questions,
    bodies: {
      lowered: sent.filter((fn) => fn.lowered !== undefined).length,
      sides: sent.length,
    },
  };
}

const skippedOf = ({ scope, skipped }: ScopeQuestions): SkippedPair[] =>
  skipped.map((p) => ({
    scope,
    a: located(p.a),
    b: located(p.b),
    graphConfidence: p.graphConfidence,
  }));

const addBodies = (x: Bodies, y: Bodies): Bodies => ({
  lowered: x.lowered + y.lowered,
  sides: x.sides + y.sides,
});

const pairCount = (questions: readonly Question[]) =>
  questions.reduce((sum, q) => sum + q.pairs.length, 0);

async function judgeScope(
  options: PairsOptions,
  ledger: Ledger,
  scoped: ScopeQuestions,
): Promise<Spent> {
  const todo = scoped.questions.filter((q) => {
    if (q.cached === undefined) return true;
    for (const row of q.cached) ledger.judged.set(row.id, row);
    return false;
  });
  options.log?.(
    options.jev.mode === "pairwise"
      ? `${scoped.scope}: ${pairCount(scoped.questions)} pairs, ${todo.length} to ask`
      : `${scoped.scope}: ${pairCount(scoped.questions)} pairs on ${scoped.anchors} anchors, ${todo.length} anchors to ask`,
  );
  let spent: Spent = { input: 0, output: 0 };
  await pool(todo, options.concurrency ?? 6, async (question) => {
    try {
      const { rows, usage } = await question.ask(options.jev);
      for (const row of rows) ledger.judged.set(row.id, row);
      spent = {
        input: spent.input + usage.input_tokens,
        output: spent.output + usage.output_tokens,
      };
      ledger.save();
    } catch (error) {
      const [first] = question.pairs;
      const what =
        first === undefined
          ? "a question"
          : question.pairs.length === 1
            ? `${functionKey(first.a)} × ${functionKey(first.b)}`
            : `the anchor over ${question.pairs.length} pairs from ${functionKey(first.a)} × ${functionKey(first.b)}`;
      options.log?.(
        `${what} failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  });
  return spent;
}

/**
 * Ask Jev about each code-graph collapse pair within the partner cap, in the client's mode, reusing
 * any answer already on file for the same question sent the same way.
 */
export async function runPairs(options: PairsOptions): Promise<PairsResult> {
  const rerun = new Set(options.targets.map((t) => t.scope));
  const ledger = openLedger(options.outPath, rerun);
  let spent: Spent = { input: 0, output: 0 };
  let bodies: Bodies = { lowered: 0, sides: 0 };
  const skipped: SkippedPair[] = [];
  for (const target of options.targets) {
    const scoped = questionsFor(options, options.jev.mode, ledger, target);
    skipped.push(...skippedOf(scoped));
    bodies = addBodies(bodies, scoped.bodies);
    const run = await judgeScope(options, ledger, scoped);
    spent = {
      input: spent.input + run.input,
      output: spent.output + run.output,
    };
  }
  ledger.save();
  return { rows: ledger.rows(), spent, skipped, bodies };
}

// ── the dry run ───────────────────────────────────────────────────────────

/**
 * A request's estimated input tokens: its JSON at about four characters per token. No tokenizer is
 * bundled, so this is a deterministic stand-in, not the provider's count.
 */
export const estimatedTokens = (request: JevRequest): number =>
  Math.ceil(JSON.stringify(request).length / 4);

export interface ScopePlan {
  readonly scope: string;
  /** Collapse pairs whose two functions were read at `--ref`. */
  readonly candidates: number;
  /** Functions the pairs were dealt to as anchors. */
  readonly anchors: number;
  /** Distinct functions across those pairs. */
  readonly functions: number;
  readonly skipped: number;
  /** Jev calls no cached answer serves: one per pair in pairwise mode, one per anchor in anchor mode. */
  readonly toAsk: number;
  /** `estimatedTokens` summed over the request each call to make would send. */
  readonly tokens: number;
}

export interface PairsPlan {
  readonly mode: PairsMode;
  readonly scopes: readonly ScopePlan[];
  readonly candidates: number;
  readonly anchors: number;
  readonly functions: number;
  readonly skipped: number;
  readonly toAsk: number;
  readonly tokens: number;
  readonly bodies: Bodies;
}

const functionsOf = (pairs: readonly Pair[]) =>
  new Set(pairs.flatMap((p) => [functionKey(p.a), functionKey(p.b)]));

/**
 * What `runPairs` would ask in `mode`, priced before any Jev call: the same questions after the
 * same cap, cache and body choice, each estimated over the exact request it would send under
 * `model`. Writes nothing.
 */
export function planPairs(
  options: PairsSelection & {
    readonly mode: PairsMode;
    readonly model: string;
  },
): PairsPlan {
  const rerun = new Set(options.targets.map((t) => t.scope));
  const ledger = openLedger(options.outPath, rerun);
  const scopes: ScopePlan[] = [];
  const candidates: Pair[] = [];
  let bodies: Bodies = { lowered: 0, sides: 0 };
  for (const target of options.targets) {
    const scoped = questionsFor(options, options.mode, ledger, target);
    const todo = scoped.questions.filter((q) => q.cached === undefined);
    candidates.push(...scoped.candidates);
    bodies = addBodies(bodies, scoped.bodies);
    scopes.push({
      scope: scoped.scope,
      candidates: scoped.candidates.length,
      anchors: scoped.anchors,
      functions: functionsOf(scoped.candidates).size,
      skipped: scoped.skipped.length,
      toAsk: todo.length,
      tokens: todo.reduce(
        (sum, q) => sum + estimatedTokens(q.request(options.model)),
        0,
      ),
    });
  }
  const total = (
    field: "candidates" | "anchors" | "skipped" | "toAsk" | "tokens",
  ) => scopes.reduce((sum, s) => sum + s[field], 0);
  return {
    mode: options.mode,
    scopes,
    candidates: total("candidates"),
    anchors: total("anchors"),
    functions: functionsOf(candidates).size,
    skipped: total("skipped"),
    toAsk: total("toAsk"),
    tokens: total("tokens"),
    bodies,
  };
}
