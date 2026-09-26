import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { SourceFile } from "ts-morph";
import { absurd } from "../absurd.js";
import {
  exactRenames,
  git,
  stagedPaths,
  trackedPaths,
  uncommittedPaths,
} from "../git.js";
import { canonicalJson, contentHash } from "../lowering/artifact.js";
import {
  hasDangling,
  heal,
  type MovedModules,
  moduleLiterals,
  movedModules,
} from "./heal.js";
import type { Manifest, MoveRow } from "./manifest.js";
import { applyMoves } from "./mover.js";
import { loadMoveProject } from "./project.js";

export type RowState =
  | { readonly kind: "pending"; readonly row: MoveRow }
  | { readonly kind: "done"; readonly row: MoveRow }
  | { readonly kind: "absent"; readonly row: MoveRow }
  | { readonly kind: "conflict"; readonly row: MoveRow };

export function stateOf(repoRoot: string, row: MoveRow): RowState {
  const from = existsSync(join(repoRoot, row.from));
  const to = existsSync(join(repoRoot, row.to));
  if (from && to) return { kind: "conflict", row };
  if (from) return { kind: "pending", row };
  if (to) return { kind: "done", row };
  return { kind: "absent", row };
}

/** The commits one apply made: the renames, then the import rewrites; `null` where it made none. */
export type ApplyCommits = {
  readonly rename: string | null;
  readonly rewrite: string | null;
};

export type ApplyReport = {
  readonly pending: number;
  readonly done: number;
  readonly absent: readonly string[];
  readonly moved: number;
  readonly healed: number;
  readonly specifiersRewritten: number;
  /** Files the rewrite commit changed. */
  readonly filesTouched: number;
  /** `untouched` when nothing needed rewriting, `no formatter` when the repo has no biome, else biome's verdict. */
  readonly lint: string;
  readonly commits: ApplyCommits;
  readonly staleStringRefs: readonly string[];
  readonly millis: number;
};

const specifiersOf = (sf: SourceFile) =>
  moduleLiterals(sf).map((l) => l.getLiteralValue());

const differing = (before: readonly string[], after: readonly string[]) =>
  before.reduce((n, spec, i) => n + (after[i] === spec ? 0 : 1), 0);

/** Old paths still written as text somewhere — a string a move cannot rewrite, for a human to read. */
function staleRefs(repoRoot: string, moved: readonly MoveRow[]): string[] {
  const hits = new Set<string>();
  for (const { from } of moved) {
    const needle = from.replace(/\.tsx?$/, "");
    let out = "";
    try {
      out = git(repoRoot, ["grep", "-n", "-F", needle, "--", ":!*.md"]);
    } catch {
      continue;
    }
    for (const line of out.split("\n").filter(Boolean)) hits.add(line);
  }
  return [...hits].sort();
}

type Ledger = {
  readonly pending: MoveRow[];
  readonly conflicts: MoveRow[];
  readonly absent: string[];
  done: number;
};

function classify(repoRoot: string, rows: readonly MoveRow[]): Ledger {
  const ledger: Ledger = { pending: [], conflicts: [], absent: [], done: 0 };
  for (const state of rows.map((row) => stateOf(repoRoot, row))) {
    switch (state.kind) {
      case "pending":
        ledger.pending.push(state.row);
        break;
      case "done":
        ledger.done += 1;
        break;
      case "absent":
        ledger.absent.push(state.row.from);
        break;
      case "conflict":
        ledger.conflicts.push(state.row);
        break;
      default:
        return absurd(state);
    }
  }
  return ledger;
}

/** Biome over the touched files when the repo has it installed; without it, files stay as ts-morph wrote them. */
function format(repoRoot: string, paths: readonly string[]): string {
  const biome = join(repoRoot, "node_modules/.bin/biome");
  if (!existsSync(biome)) return "no formatter";
  try {
    execFileSync(
      biome,
      ["check", "--write", "--no-errors-on-unmatched", ...paths],
      {
        cwd: repoRoot,
        stdio: "pipe",
      },
    );
    return "clean";
  } catch (error) {
    return error instanceof Error
      ? (error.message.split("\n")[0] ?? "biome failed")
      : "biome failed";
  }
}

/** Names the manifest in both commit messages, so a re-run can tell its own rename commit at HEAD. */
const MANIFEST_TRAILER = "Structure-Sweep-Manifest";
const RENAME_TRAILER = "Structure-Sweep-Step: rename";

const manifestId = (manifest: Manifest) => contentHash(canonicalJson(manifest));

const renameMessage = (count: number, id: string) =>
  `structure-sweep move: rename ${count} file${count === 1 ? "" : "s"} into feature folders

Content unchanged, so git records each move as a 100% rename and history follows it.
The import rewrites follow in the next commit.

${RENAME_TRAILER}
${MANIFEST_TRAILER}: ${id}
`;

const rewriteMessage = (id: string) =>
  `structure-sweep move: rewrite imports after the renames

Specifier rewrites, heals and formatting for the files the previous commit moved.

${MANIFEST_TRAILER}: ${id}
`;

function commit(repoRoot: string, message: string): string {
  git(repoRoot, ["commit", "-q", "-m", message]);
  return git(repoRoot, ["rev-parse", "HEAD"]).trim();
}

/** One commit holding only the pending renames, each file byte-identical at its new path. */
function commitRenames(
  repoRoot: string,
  pending: readonly MoveRow[],
  id: string,
): string {
  for (const row of pending) {
    mkdirSync(dirname(join(repoRoot, row.to)), { recursive: true });
    git(repoRoot, ["mv", "--", row.from, row.to]);
  }
  return commit(repoRoot, renameMessage(pending.length, id));
}

/**
 * The rows HEAD renamed, when HEAD is this manifest's rename commit — the renames whose import
 * rewrites are still owed, whether this run just made that commit or an earlier one stopped after it.
 */
function renamedAtHead(
  repoRoot: string,
  manifest: Manifest,
  id: string,
): MoveRow[] {
  const message = git(repoRoot, ["log", "-1", "--format=%B", "HEAD"]);
  const lines = new Set(message.split("\n"));
  if (!lines.has(RENAME_TRAILER) || !lines.has(`${MANIFEST_TRAILER}: ${id}`))
    return [];
  const destinations = new Set(
    exactRenames(repoRoot, "HEAD").map(({ to }) => to),
  );
  return manifest.moves.filter((row) => destinations.has(row.to));
}

/**
 * Rewrite the imports `renamed` owes over the renamed tree on disk. ts-morph reads the files back at
 * their old paths in memory and moves them, so every specifier is rewritten from the directory it
 * was written in; heal then fixes any relative specifier still left dangling. Only files whose text
 * changed are written.
 */
function rewrite(
  repoRoot: string,
  scope: string,
  renamed: readonly MoveRow[],
  moved: MovedModules,
) {
  const scopeRoot = join(repoRoot, scope);
  const project = loadMoveProject(scopeRoot, repoRoot);
  for (const row of renamed) {
    const at = project.getSourceFileOrThrow(join(repoRoot, row.to));
    const text = at.getFullText();
    project.removeSourceFile(at);
    project.createSourceFile(join(repoRoot, row.from), text);
  }
  const before = new Map(
    project.getSourceFiles().map((sf) => [sf, specifiersOf(sf)]),
  );
  applyMoves(
    project,
    scopeRoot,
    renamed.map((r) => [
      relative(scopeRoot, join(repoRoot, r.from)),
      relative(scopeRoot, join(repoRoot, r.to)),
    ]),
  );
  const healed = heal(project.getSourceFiles(), moved);
  const written: string[] = [];
  let specifiersRewritten = 0;
  for (const sf of project.getSourceFiles()) {
    const path = sf.getFilePath();
    const text = sf.getFullText();
    if (existsSync(path) && readFileSync(path, "utf8") === text) continue;
    writeFileSync(path, text);
    written.push(relative(repoRoot, path));
    specifiersRewritten += differing(before.get(sf) ?? [], specifiersOf(sf));
  }
  return { healed, specifiersRewritten, written };
}

function scopeSources(repoRoot: string, scope: string): string[] {
  return trackedPaths(repoRoot, "index", scope)
    .filter((p) => /\.tsx?$/.test(p) && existsSync(join(repoRoot, p)))
    .map((p) => join(repoRoot, p));
}

/**
 * Carry out a manifest over a clean tree in two commits. The first renames every pending row with
 * its content unchanged, so git scores each as a 100% rename and `git log --follow` keeps its
 * history; the second rewrites the imports that named the moved files, heals any specifier a move
 * left dangling and formats what changed. A pure function of HEAD and the manifest: over the same
 * HEAD it makes the same trees and messages. A re-run over a finished manifest commits nothing; one
 * over this manifest's rename commit alone makes the rewrite commit.
 */
export function applyManifest(
  repoRoot: string,
  manifest: Manifest,
): ApplyReport {
  const started = performance.now();
  // Untracked files may stay: apply commits only the paths it moved or rewrote.
  const dirty = uncommittedPaths(repoRoot);
  if (dirty.length > 0)
    throw new Error(
      `uncommitted changes, refusing to apply over them; commit or discard them first:\n${dirty.map((d) => `  ${d}`).join("\n")}`,
    );
  const { pending, conflicts, absent, done } = classify(
    repoRoot,
    manifest.moves,
  );
  if (conflicts.length > 0)
    throw new Error(
      `both ends exist, refusing to guess:\n${conflicts.map((r) => `  ${r.from} -> ${r.to}`).join("\n")}`,
    );
  const id = manifestId(manifest);
  const moved = movedModules(repoRoot, manifest.moves);

  const rename =
    pending.length > 0 ? commitRenames(repoRoot, pending, id) : null;
  const renamed = renamedAtHead(repoRoot, manifest, id);
  const owed =
    renamed.length > 0 ||
    hasDangling(scopeSources(repoRoot, manifest.scope), moved);
  const { healed, specifiersRewritten, written } = owed
    ? rewrite(repoRoot, manifest.scope, renamed, moved)
    : { healed: 0, specifiersRewritten: 0, written: [] };

  const lint = written.length > 0 ? format(repoRoot, written) : "untouched";
  if (written.length > 0) git(repoRoot, ["add", "--", ...written]);
  const changed = stagedPaths(repoRoot);
  const rewriteSha =
    changed.length > 0 ? commit(repoRoot, rewriteMessage(id)) : null;

  return {
    pending: pending.length,
    done,
    absent,
    moved: pending.length,
    healed,
    specifiersRewritten,
    filesTouched: changed.length,
    lint,
    commits: { rename, rewrite: rewriteSha },
    staleStringRefs: staleRefs(repoRoot, manifest.moves),
    millis: Math.round(performance.now() - started),
  };
}
