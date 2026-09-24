import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { loadEdgeProject } from "@demlik/code-graph/project";
import type { SourceFile } from "ts-morph";
import { absurd } from "../absurd.js";
import { git } from "../git.js";
import {
  hasDangling,
  heal,
  type MovedModules,
  moduleLiterals,
  movedModules,
} from "./heal.js";
import type { Manifest, MoveRow } from "./manifest.js";
import { applyMoves } from "./mover.js";

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

export type ApplyReport = {
  readonly pending: number;
  readonly done: number;
  readonly absent: readonly string[];
  readonly moved: number;
  readonly healed: number;
  readonly specifiersRewritten: number;
  readonly filesTouched: number;
  /** `untouched` when nothing needed doing, `no formatter` when the repo has no biome, else biome's verdict. */
  readonly lint: string;
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

function moveAndMeasure(
  repoRoot: string,
  scope: string,
  pending: readonly MoveRow[],
  moved: MovedModules,
) {
  const scopeRoot = join(repoRoot, scope);
  const { project } = loadEdgeProject(scopeRoot, "package", repoRoot);
  const before = new Map(
    project.getSourceFiles().map((sf) => [sf, specifiersOf(sf)]),
  );
  applyMoves(
    project,
    scopeRoot,
    pending.map((r) => [
      relative(scopeRoot, join(repoRoot, r.from)),
      relative(scopeRoot, join(repoRoot, r.to)),
    ]),
  );
  const touched = new Set(
    project.getSourceFiles().filter((sf) => !sf.isSaved()),
  );
  project.saveSync();
  const healed = heal(project.getSourceFiles(), moved);
  for (const sf of project.getSourceFiles()) if (!sf.isSaved()) touched.add(sf);
  project.saveSync();
  return {
    healed,
    specifiersRewritten: [...touched].reduce(
      (n, sf) => n + differing(before.get(sf) ?? [], specifiersOf(sf)),
      0,
    ),
    touchedPaths: [...touched].map((sf) =>
      relative(repoRoot, sf.getFilePath()),
    ),
  };
}

function scopeSources(repoRoot: string, scope: string): string[] {
  return git(repoRoot, ["ls-files", "--", scope])
    .split("\n")
    .filter((p) => /\.tsx?$/.test(p) && existsSync(join(repoRoot, p)))
    .map((p) => join(repoRoot, p));
}

/**
 * Carry out a manifest: move every pending row, rewrite the imports that named it, heal any
 * specifier a move left dangling, and stage the result. Idempotent — a row whose file already sits
 * at `to` is done, and a second run over a finished manifest touches nothing.
 */
export function applyManifest(
  repoRoot: string,
  manifest: Manifest,
): ApplyReport {
  const started = performance.now();
  const { pending, conflicts, absent, done } = classify(
    repoRoot,
    manifest.moves,
  );
  if (conflicts.length > 0)
    throw new Error(
      `both ends exist, refusing to guess:\n${conflicts.map((r) => `  ${r.from} -> ${r.to}`).join("\n")}`,
    );
  const report = (
    moved: number,
    healed: number,
    specifiersRewritten: number,
    filesTouched: number,
    lint: string,
  ): ApplyReport => ({
    pending: pending.length,
    done,
    absent,
    moved,
    healed,
    specifiersRewritten,
    filesTouched,
    lint,
    staleStringRefs: staleRefs(repoRoot, manifest.moves),
    millis: Math.round(performance.now() - started),
  });
  const moved = movedModules(repoRoot, manifest.moves);
  if (
    pending.length === 0 &&
    !hasDangling(scopeSources(repoRoot, manifest.scope), moved)
  )
    return report(0, 0, 0, 0, "untouched");

  const { healed, specifiersRewritten, touchedPaths } = moveAndMeasure(
    repoRoot,
    manifest.scope,
    pending,
    moved,
  );
  const lint = format(repoRoot, touchedPaths);
  git(repoRoot, [
    "add",
    "-A",
    "--",
    ...pending.map((r) => r.from),
    ...touchedPaths,
  ]);
  return report(
    pending.length,
    healed,
    specifiersRewritten,
    touchedPaths.length,
    lint,
  );
}
