import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JevRequest } from "@demlik/tea/jev";
import { type JevClient, pool } from "../jev.js";
import type { LoweringGraph } from "../lowering/lower.js";
import { capPartners, DEFAULT_MAX_PARTNERS, functionKey } from "./cap.js";
import { loadPairs, type Pair, type PairFunction } from "./collapse.js";
import { type PairQuestions, pairQuestions } from "./questions.js";
import type { JudgedFunction, PairRow, SkippedPair } from "./report.js";

export interface PairTarget {
  /** The folder code-graph ran on, repo-relative; the collapse report's paths are relative to it. */
  readonly scope: string;
  /** The `code-graph <scope> --collapse --json` output. */
  readonly collapsePath: string;
}

/** What decides which pairs are asked and what each is shown: every option but the Jev client. */
export interface PairsSelection {
  readonly root: string;
  readonly ref: string;
  readonly targets: readonly PairTarget[];
  readonly outPath: string;
  /** Show Jev each function's name and source only, never its file path. */
  readonly redact?: boolean;
  /** The most partners any one function is judged against (default `DEFAULT_MAX_PARTNERS`). */
  readonly maxPartners?: number;
  /**
   * The code-graph `--graph` nodes for the targets' scope. With them, each side is sent as its
   * stage-2 lowered body where stage 2 lowers the whole function, and as its source otherwise.
   */
  readonly graph?: LoweringGraph;
  readonly log?: (line: string) => void;
}

export interface PairsOptions extends PairsSelection {
  readonly jev: JevClient<PairQuestions>;
  readonly concurrency?: number;
}

export interface Spent {
  readonly input: number;
  readonly output: number;
}

/** How many sides of the asked-about pairs went out as a lowered body, of all sides. */
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

/** One side of a pair as Jev sees it: redacted, the path is gone and only the code is left to judge. */
const shown = (fn: PairFunction, redact: boolean) => {
  const body =
    fn.lowered === undefined ? { source: fn.source } : { lowered: fn.lowered };
  return redact
    ? { function: fn.function, ...body }
    : { path: fn.path, function: fn.function, ...body };
};

const stateOf = (pair: Pair, redact: boolean) => ({
  a: shown(pair.a, redact),
  b: shown(pair.b, redact),
  signals: pair.signals,
});

/** A hash of the lowered bodies a pair sends; `undefined` when both sides go out as source. */
function loweredHash(pair: Pair): string | undefined {
  if (pair.a.lowered === undefined && pair.b.lowered === undefined)
    return undefined;
  return createHash("sha256")
    .update(JSON.stringify([pair.a.lowered ?? null, pair.b.lowered ?? null]))
    .digest("hex")
    .slice(0, 16);
}

/**
 * A cached answer serves a pair only when both bodies, the redaction mode and the lowered bodies sent
 * all match, so a redacted run never reuses a plain answer, nor a lowered send a raw one, nor the
 * other way round. A plain raw row keeps its bare `id` key.
 */
const cacheKey = (id: string, redacted: boolean, lowered?: string) =>
  [id, redacted ? "redacted" : "", lowered ? `lowered ${lowered}` : ""]
    .filter((part) => part !== "")
    .join(" ");

interface Ledger {
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
      previous.map((r) => [cacheKey(r.id, r.redacted === true, r.lowered), r]),
    ),
    judged,
    rows,
    save: () => {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${JSON.stringify(rows(), null, 1)}\n`);
    },
  };
}

/** Pairs whose two bodies were judged before, sent the same way, keep their answer; only the rest are asked. */
function pairsToAsk(
  ledger: Ledger,
  scope: string,
  pairs: readonly Pair[],
  redact: boolean,
): Pair[] {
  return pairs.filter((p) => {
    const hit = ledger.cache.get(cacheKey(p.id, redact, loweredHash(p)));
    if (hit === undefined) return true;
    ledger.judged.set(p.id, {
      ...hit,
      scope,
      a: located(p.a),
      b: located(p.b),
      signals: p.signals,
    });
    return false;
  });
}

/** One scope's collapse pairs, split by the partner cap into the ones to judge and the ones skipped. */
interface ScopePairs {
  readonly scope: string;
  readonly candidates: readonly Pair[];
  readonly kept: readonly Pair[];
  readonly skipped: readonly Pair[];
}

function selectPairs(
  options: PairsSelection,
  { scope, collapsePath }: PairTarget,
): ScopePairs {
  const candidates = loadPairs(
    options.root,
    options.ref,
    scope,
    collapsePath,
    options.log,
    options.graph,
  );
  const { kept, skipped } = capPartners(
    candidates,
    options.maxPartners ?? DEFAULT_MAX_PARTNERS,
  );
  return { scope, candidates, kept, skipped };
}

const skippedOf = ({ scope, skipped }: ScopePairs): SkippedPair[] =>
  skipped.map((p) => ({
    scope,
    a: located(p.a),
    b: located(p.b),
    graphConfidence: p.graphConfidence,
  }));

const bodiesOf = (pairs: readonly Pair[]): Bodies => ({
  lowered: pairs
    .flatMap((p) => [p.a, p.b])
    .filter((fn) => fn.lowered !== undefined).length,
  sides: pairs.length * 2,
});

async function judgeScope(
  options: PairsOptions,
  ledger: Ledger,
  scope: string,
  pairs: readonly Pair[],
): Promise<Spent> {
  const redact = options.redact === true;
  const todo = pairsToAsk(ledger, scope, pairs, redact);
  options.log?.(`${scope}: ${pairs.length} pairs, ${todo.length} to ask`);
  let spent: Spent = { input: 0, output: 0 };
  await pool(todo, options.concurrency ?? 6, async (pair) => {
    try {
      const ok = await options.jev(stateOf(pair, redact));
      const lowered = loweredHash(pair);
      ledger.judged.set(pair.id, {
        id: pair.id,
        scope,
        a: located(pair.a),
        b: located(pair.b),
        signals: pair.signals,
        graphConfidence: pair.graphConfidence,
        ...(redact ? { redacted: true as const } : {}),
        ...(lowered === undefined ? {} : { lowered }),
        answers: ok.answers,
        model: ok.model,
        usage: ok.usage,
      });
      spent = {
        input: spent.input + ok.usage.input_tokens,
        output: spent.output + ok.usage.output_tokens,
      };
      ledger.save();
    } catch (error) {
      options.log?.(
        `${pair.a.path}:${pair.a.function} × ${pair.b.path}:${pair.b.function} failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  });
  return spent;
}

/**
 * Ask Jev what each code-graph collapse pair within the partner cap means, reusing any answer already
 * on file for the same two bodies sent the same way.
 */
export async function runPairs(options: PairsOptions): Promise<PairsResult> {
  const rerun = new Set(options.targets.map((t) => t.scope));
  const ledger = openLedger(options.outPath, rerun);
  let spent: Spent = { input: 0, output: 0 };
  const skipped: SkippedPair[] = [];
  const asked: Pair[] = [];
  for (const target of options.targets) {
    const selected = selectPairs(options, target);
    skipped.push(...skippedOf(selected));
    asked.push(...selected.kept);
    const run = await judgeScope(
      options,
      ledger,
      selected.scope,
      selected.kept,
    );
    spent = {
      input: spent.input + run.input,
      output: spent.output + run.output,
    };
  }
  ledger.save();
  return { rows: ledger.rows(), spent, skipped, bodies: bodiesOf(asked) };
}

// ── the dry run ───────────────────────────────────────────────────────────

/**
 * A request's estimated input tokens: its JSON at about four characters per token. No tokenizer is
 * bundled, so this is a deterministic stand-in, not the provider's count.
 */
export const estimatedTokens = (request: JevRequest<PairQuestions>): number =>
  Math.ceil(JSON.stringify(request).length / 4);

export interface ScopePlan {
  readonly scope: string;
  /** Collapse pairs whose two functions were read at `--ref`. */
  readonly candidates: number;
  /** Distinct functions across those pairs. */
  readonly functions: number;
  readonly skipped: number;
  /** Pairs within the cap that no cached answer serves. */
  readonly toAsk: number;
  /** `estimatedTokens` summed over the request each pair to ask would send. */
  readonly tokens: number;
}

export interface PairsPlan {
  readonly scopes: readonly ScopePlan[];
  readonly candidates: number;
  readonly functions: number;
  readonly skipped: number;
  readonly toAsk: number;
  readonly tokens: number;
  readonly bodies: Bodies;
}

const functionsOf = (pairs: readonly Pair[]) =>
  new Set(pairs.flatMap((p) => [functionKey(p.a), functionKey(p.b)]));

/**
 * What `runPairs` would ask, priced before any Jev call: the same pairs after the same cap, cache and
 * body choice, each estimated over the exact request it would send under `model`. Writes nothing.
 */
export function planPairs(
  options: PairsSelection & { readonly model: string },
): PairsPlan {
  const rerun = new Set(options.targets.map((t) => t.scope));
  const ledger = openLedger(options.outPath, rerun);
  const redact = options.redact === true;
  const scopes: ScopePlan[] = [];
  const candidates: Pair[] = [];
  const asked: Pair[] = [];
  for (const target of options.targets) {
    const selected = selectPairs(options, target);
    const todo = pairsToAsk(ledger, selected.scope, selected.kept, redact);
    candidates.push(...selected.candidates);
    asked.push(...selected.kept);
    scopes.push({
      scope: selected.scope,
      candidates: selected.candidates.length,
      functions: functionsOf(selected.candidates).size,
      skipped: selected.skipped.length,
      toAsk: todo.length,
      tokens: todo.reduce(
        (sum, pair) =>
          sum +
          estimatedTokens({
            state: stateOf(pair, redact),
            model: options.model,
            questions: pairQuestions,
          }),
        0,
      ),
    });
  }
  const total = (field: "candidates" | "skipped" | "toAsk" | "tokens") =>
    scopes.reduce((sum, s) => sum + s[field], 0);
  return {
    scopes,
    candidates: total("candidates"),
    functions: functionsOf(candidates).size,
    skipped: total("skipped"),
    toAsk: total("toAsk"),
    tokens: total("tokens"),
    bodies: bodiesOf(asked),
  };
}
