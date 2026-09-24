import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JevUsage } from "@demlik/tea/jev";
import { type JevClient, pool } from "../jev.js";
import type { Vocabulary } from "../vocabulary.js";
import {
  type FileEvidence,
  gatherEvidence,
  listSources,
  type SourceFile,
} from "./evidence.js";
import type { GraphFacts } from "./graph.js";
import type { SweepAnswers, SweepQuestions } from "./questions.js";

/** One judged file. `hash` and `vocabulary` together are the cache key: both must match to skip. */
export interface SweepRow {
  readonly path: string;
  readonly scope: string;
  readonly hash: string;
  readonly vocabulary: string;
  readonly answers: SweepAnswers;
  readonly model: string;
  readonly usage: JevUsage;
}

export interface SweepOptions {
  readonly root: string;
  readonly ref: string;
  readonly scopes: readonly string[];
  readonly vocabulary: Vocabulary;
  readonly jev: JevClient<SweepQuestions>;
  /** The verdict file. Read when it exists, created when it does not. */
  readonly verdictsPath: string;
  readonly graph?: ReadonlyMap<string, GraphFacts>;
  readonly concurrency?: number;
  readonly log?: (line: string) => void;
}

export interface SweepScopeResult {
  readonly scope: string;
  readonly files: number;
  readonly cached: number;
  readonly asked: number;
  readonly failed: readonly string[];
}

export interface SweepResult {
  readonly scopes: readonly SweepScopeResult[];
  readonly rows: readonly SweepRow[];
}

interface Verdicts {
  readonly done: Map<string, SweepRow>;
  save(): void;
}

function openVerdicts(path: string): Verdicts {
  const previous: SweepRow[] = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : [];
  const done = new Map(previous.map((r) => [r.path, r]));
  const sorted = () =>
    [...done.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    done,
    save: () => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(sorted(), null, 1)}\n`);
    },
  };
}

const isCached = (
  row: SweepRow | undefined,
  file: SourceFile,
  vocabulary: Vocabulary,
) =>
  row !== undefined &&
  row.hash === file.hash &&
  row.vocabulary === vocabulary.fingerprint;

async function judgeScope(
  options: SweepOptions,
  verdicts: Verdicts,
  scope: string,
  files: readonly SourceFile[],
  evidence: ReadonlyMap<string, FileEvidence>,
): Promise<SweepScopeResult> {
  const todo = files.filter(
    (f) => !isCached(verdicts.done.get(f.path), f, options.vocabulary),
  );
  options.log?.(`${scope}: ${files.length} files, ${todo.length} to ask`);
  const failed: string[] = [];
  await pool(todo, options.concurrency ?? 6, async (file) => {
    const state = evidence.get(file.path);
    if (state === undefined) return;
    try {
      const ok = await options.jev(state);
      verdicts.done.set(file.path, {
        path: file.path,
        scope,
        hash: file.hash,
        vocabulary: options.vocabulary.fingerprint,
        answers: ok.answers,
        model: ok.model,
        usage: ok.usage,
      });
      verdicts.save();
    } catch (error) {
      failed.push(file.path);
      options.log?.(
        `${file.path} failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  });
  return {
    scope,
    files: files.length,
    cached: files.length - todo.length,
    asked: todo.length - failed.length,
    failed,
  };
}

/**
 * Judge every source file under each scope, asking Jev only about files whose content or vocabulary
 * changed since the verdict file last saw them. A scope nobody swept before is simply all misses.
 */
export async function runSweep(options: SweepOptions): Promise<SweepResult> {
  const verdicts = openVerdicts(options.verdictsPath);
  const scopes: SweepScopeResult[] = [];
  for (const scope of options.scopes) {
    const files = listSources(options.root, options.ref, scope);
    scopes.push(
      await judgeScope(
        options,
        verdicts,
        scope,
        files,
        gatherEvidence(files, options.graph),
      ),
    );
  }
  verdicts.save();
  return { scopes, rows: [...verdicts.done.values()] };
}
