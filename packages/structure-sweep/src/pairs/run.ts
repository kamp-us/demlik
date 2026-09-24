import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type JevClient, pool } from "../jev.js";
import { loadPairs, type Pair, type PairFunction } from "./collapse.js";
import type { PairQuestions } from "./questions.js";
import type { JudgedFunction, PairRow } from "./report.js";

export interface PairTarget {
  /** The folder code-graph ran on, repo-relative; the collapse report's paths are relative to it. */
  readonly scope: string;
  /** The `code-graph <scope> --collapse --json` output. */
  readonly collapsePath: string;
}

export interface PairsOptions {
  readonly root: string;
  readonly ref: string;
  readonly targets: readonly PairTarget[];
  readonly jev: JevClient<PairQuestions>;
  readonly outPath: string;
  readonly concurrency?: number;
  readonly log?: (line: string) => void;
}

export interface Spent {
  readonly input: number;
  readonly output: number;
}

export interface PairsResult {
  readonly rows: readonly PairRow[];
  readonly spent: Spent;
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

const stateOf = (pair: Pair) => ({
  a: { path: pair.a.path, function: pair.a.function, source: pair.a.source },
  b: { path: pair.b.path, function: pair.b.function, source: pair.b.source },
  signals: pair.signals,
});

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
    cache: new Map(previous.map((r) => [r.id, r])),
    judged,
    rows,
    save: () => {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${JSON.stringify(rows(), null, 1)}\n`);
    },
  };
}

/** Pairs whose two bodies were judged before keep their answer; only the rest are asked. */
function pairsToAsk(
  ledger: Ledger,
  scope: string,
  pairs: readonly Pair[],
): Pair[] {
  return pairs.filter((p) => {
    const hit = ledger.cache.get(p.id);
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

async function judgeScope(
  options: PairsOptions,
  ledger: Ledger,
  scope: string,
  pairs: readonly Pair[],
): Promise<Spent> {
  const todo = pairsToAsk(ledger, scope, pairs);
  options.log?.(`${scope}: ${pairs.length} pairs, ${todo.length} to ask`);
  let spent: Spent = { input: 0, output: 0 };
  await pool(todo, options.concurrency ?? 6, async (pair) => {
    try {
      const ok = await options.jev(stateOf(pair));
      ledger.judged.set(pair.id, {
        id: pair.id,
        scope,
        a: located(pair.a),
        b: located(pair.b),
        signals: pair.signals,
        graphConfidence: pair.graphConfidence,
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

/** Ask Jev what each code-graph collapse pair means, reusing any answer already on file for the same two bodies. */
export async function runPairs(options: PairsOptions): Promise<PairsResult> {
  const rerun = new Set(options.targets.map((t) => t.scope));
  const ledger = openLedger(options.outPath, rerun);
  let spent: Spent = { input: 0, output: 0 };
  for (const { scope, collapsePath } of options.targets) {
    const pairs = loadPairs(
      options.root,
      options.ref,
      scope,
      collapsePath,
      options.log,
    );
    const run = await judgeScope(options, ledger, scope, pairs);
    spent = {
      input: spent.input + run.input,
      output: spent.output + run.output,
    };
  }
  ledger.save();
  return { rows: ledger.rows(), spent };
}
