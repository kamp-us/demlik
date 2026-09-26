import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import type { JevUsage } from "@demlik/tea/jev";
import { trackedPaths } from "../git.js";
import { type JevClient, pool } from "../jev.js";
import { specifierResolver } from "../module-syntax.js";
import type { Vocabulary } from "../vocabulary.js";
import {
  type FileEvidence,
  gatherEvidence,
  isSweptSource,
  listSources,
  type SourceFile,
} from "./evidence.js";
import type { GraphFacts } from "./graph.js";
import type { SweepAnswers, SweepQuestions } from "./questions.js";

/**
 * Which reader built the evidence a verdict was judged on. Bump it whenever the evidence a file
 * gives changes shape, so no verdict judged on the old evidence is served again: 1 was the regex
 * reader, 2 is oxc-parser.
 */
export const EVIDENCE_EXTRACTOR = 2;

/**
 * One judged file. `hash`, `vocabulary`, `extractor` and `redacted` together are the cache key:
 * all must match to skip. `path` is always the real repo path, whatever Jev was shown.
 */
export interface SweepRow {
  readonly path: string;
  readonly scope: string;
  readonly hash: string;
  readonly vocabulary: string;
  /** `EVIDENCE_EXTRACTOR` when the row was judged; absent on a row written before it existed (1). */
  readonly extractor?: number;
  /** Present only on a row Jev answered from redacted evidence; a default row has no such field. */
  readonly redacted?: true;
  readonly answers: SweepAnswers;
  readonly model: string;
  readonly usage: JevUsage;
}

/**
 * What a run judges: every source under each folder in `scopes`, or exactly the repo-relative
 * paths in `files`. A run is told one or the other, never both.
 */
export type SweepSelection =
  | { readonly scopes: readonly string[]; readonly files?: never }
  | { readonly files: readonly string[]; readonly scopes?: never };

/** Given a batch's folder, whether Jev is asked about the file at `path` in it. */
export type Nominate = (scope: string) => (path: string) => boolean;

export type SweepOptions = SweepSelection & {
  readonly root: string;
  readonly ref: string;
  readonly vocabulary: Vocabulary;
  readonly jev: JevClient<SweepQuestions>;
  /** The verdict file. Read when it exists, created when it does not. */
  readonly verdictsPath: string;
  readonly graph?: ReadonlyMap<string, GraphFacts>;
  /** Show Jev opaque ids instead of paths, relative specifiers and sibling names. */
  readonly redact?: boolean;
  /** Ask only about the files this says yes to; absent, every uncached file is asked. */
  readonly nominate?: Nominate;
  readonly concurrency?: number;
  readonly log?: (line: string) => void;
};

export interface SweepScopeResult {
  readonly scope: string;
  readonly files: number;
  readonly cached: number;
  readonly asked: number;
  readonly failed: readonly string[];
  /** On a nominated run only: files neither cached nor nominated, so never asked. */
  readonly skipped?: number;
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
  options: SweepOptions,
) =>
  row !== undefined &&
  row.hash === file.hash &&
  row.vocabulary === options.vocabulary.fingerprint &&
  (row.extractor ?? 1) === EVIDENCE_EXTRACTOR &&
  (row.redacted === true) === (options.redact === true);

async function judgeScope(
  options: SweepOptions,
  verdicts: Verdicts,
  scope: string,
  files: readonly SourceFile[],
  evidence: ReadonlyMap<string, FileEvidence>,
  nominated: ((path: string) => boolean) | undefined,
): Promise<SweepScopeResult> {
  const uncached = files.filter(
    (f) => !isCached(verdicts.done.get(f.path), f, options),
  );
  const todo =
    nominated === undefined
      ? uncached
      : uncached.filter((f) => nominated(f.path));
  const skipped = uncached.length - todo.length;
  options.log?.(
    `${scope}: ${files.length} files, ${todo.length} to ask${nominated === undefined ? "" : `, ${skipped} skipped (not nominated)`}`,
  );
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
        extractor: EVIDENCE_EXTRACTOR,
        ...(options.redact === true ? { redacted: true as const } : {}),
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
    cached: files.length - uncached.length,
    asked: todo.length - failed.length,
    failed,
    ...(nominated === undefined ? {} : { skipped }),
  };
}

/** One folder to read: its sources are the evidence batch, and `listed` narrows who is asked. */
interface Batch {
  readonly scope: string;
  readonly listed?: ReadonlySet<string>;
}

function refusal(path: string, ref: string, tracked: ReadonlySet<string>) {
  if (!tracked.has(path)) return `not tracked at ${ref}`;
  if (!isSweptSource(path))
    return "not a swept source (.ts/.tsx, not a test, story or .d.ts)";
  if (posix.dirname(path) === ".")
    return "at the repository root, which no folder sweep covers";
  return undefined;
}

/**
 * A file list as batches, one per parent folder, so each listed file is judged over the same
 * evidence a sweep of that folder gives it. Throws naming every path it cannot judge.
 */
function listedBatches(
  root: string,
  ref: string,
  files: readonly string[],
): Batch[] {
  const tracked = new Set(trackedPaths(root, { ref }));
  const unique = [...new Set(files)];
  const refused = unique.flatMap((path) => {
    const reason = refusal(path, ref, tracked);
    return reason === undefined ? [] : [`  ${path}: ${reason}`];
  });
  if (refused.length > 0) {
    throw new Error(
      `the file list names ${refused.length} path(s) sweep cannot judge:\n${refused.join("\n")}`,
    );
  }
  const byFolder = new Map<string, Set<string>>();
  for (const path of unique) {
    const folder = posix.dirname(path);
    byFolder.set(folder, (byFolder.get(folder) ?? new Set()).add(path));
  }
  return [...byFolder]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scope, listed]) => ({ scope, listed }));
}

/**
 * Judge every source file under each scope — or, given `files`, exactly those files — asking Jev
 * only about files whose content or vocabulary changed since the verdict file last saw them. A
 * scope nobody swept before is simply all misses.
 */
export async function runSweep(options: SweepOptions): Promise<SweepResult> {
  const batches: readonly Batch[] =
    options.files !== undefined
      ? listedBatches(options.root, options.ref, options.files)
      : options.scopes.map((scope) => ({ scope }));
  const verdicts = openVerdicts(options.verdictsPath);
  const scopes: SweepScopeResult[] = [];
  for (const { scope, listed } of batches) {
    const sources = listSources(options.root, options.ref, scope);
    const evidence = gatherEvidence(
      sources,
      options.graph,
      options.redact === true
        ? {
            redact: true,
            resolve: specifierResolver(options.root, scope),
          }
        : {},
    );
    const judged =
      listed === undefined
        ? sources
        : sources.filter((f) => listed.has(f.path));
    scopes.push(
      await judgeScope(
        options,
        verdicts,
        scope,
        judged,
        evidence,
        options.nominate?.(scope),
      ),
    );
  }
  verdicts.save();
  return { scopes, rows: [...verdicts.done.values()] };
}
