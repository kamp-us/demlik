import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type ChurnWindow = {
  sinceIso: string;
  untilIso: string;
  days: number;
};

export function resolveChurnWindow(days: number, sinceIso: string | undefined): ChurnWindow {
  const until = new Date();
  const since =
    sinceIso !== undefined ? new Date(sinceIso) : new Date(until.getTime() - days * 86_400_000);
  const spanDays = Math.max(0, Math.round((until.getTime() - since.getTime()) / 86_400_000));
  return { sinceIso: since.toISOString(), untilIso: until.toISOString(), days: spanDays };
}

export type Reporter = (message: string) => void;

function parseStrictNonNegativeInt(raw: string, flag: string, report: Reporter): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    report(`${flag} expects a non-negative integer, got "${raw}".`);
    return null;
  }
  return Number.parseInt(trimmed, 10);
}

export function resolveHotspotsCliOptions(
  daysRaw: string,
  limitRaw: string,
  report: Reporter,
): { days: number; limit: number } | null {
  const days = parseStrictNonNegativeInt(daysRaw, "--hotspots-days", report);
  if (days === null) return null;
  const limit = parseStrictNonNegativeInt(limitRaw, "--hotspots-limit", report);
  if (limit === null) return null;
  return { days, limit };
}

export type ChurnData = {
  repoRoot: string;
  headSha: string;
  commitsByFile: Map<string, number>;
  trackedFiles: Set<string>;
};

function runGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function underPrefix(prefix: string, relToRepo: string): string | null {
  if (prefix === "") return relToRepo;
  const withSlash = `${prefix}/`;
  return relToRepo.startsWith(withSlash) ? relToRepo.slice(withSlash.length) : null;
}

function resolveRealRoot(rootAbsolute: string): string | null {
  try {
    return fs.realpathSync(rootAbsolute);
  } catch {
    return null;
  }
}

function prefixOf(repoRootNormalized: string, realRoot: string): string {
  const rootPosix = realRoot.split(path.sep).join("/");
  return path.posix.relative(repoRootNormalized, rootPosix);
}

function parseTrackedFiles(lsFilesOutput: string, prefix: string): Set<string> {
  const trackedFiles = new Set<string>();
  for (const line of lsFilesOutput.split("\n")) {
    if (line === "") continue;
    const rel = underPrefix(prefix, line);
    if (rel !== null) trackedFiles.add(rel);
  }
  return trackedFiles;
}

function parseCommitCounts(logOutput: string, prefix: string): Map<string, number> {
  const commitsByFile = new Map<string, number>();
  for (const chunk of logOutput.split("\0")) {
    const filesInCommit = new Set<string>();
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const rel = underPrefix(prefix, trimmed);
      if (rel !== null) filesInCommit.add(rel);
    }
    for (const rel of filesInCommit) {
      commitsByFile.set(rel, (commitsByFile.get(rel) ?? 0) + 1);
    }
  }
  return commitsByFile;
}

export function loadChurn(rootAbsolute: string, window: ChurnWindow): ChurnData | null {
  const realRoot = resolveRealRoot(rootAbsolute);
  if (realRoot === null) return null;

  const repoRoot = runGit(["rev-parse", "--show-toplevel"], realRoot)?.trim();
  if (!repoRoot) return null;
  const repoRootNormalized = repoRoot.split(path.sep).join("/");

  const headSha = runGit(["rev-parse", "HEAD"], realRoot)?.trim();
  if (!headSha) return null;

  const prefix = prefixOf(repoRootNormalized, realRoot);
  const pathspecArgs = prefix === "" ? [] : ["--", prefix];

  const tracked = runGit(["ls-files", ...pathspecArgs], repoRootNormalized);
  if (tracked === null) return null;

  const log = runGit(
    [
      "log",
      `--since=${window.sinceIso}`,
      `--until=${window.untilIso}`,
      "--name-only",
      "--pretty=format:%x00",
      ...pathspecArgs,
    ],
    repoRootNormalized,
  );
  if (log === null) return null;

  return {
    repoRoot: repoRootNormalized,
    headSha,
    commitsByFile: parseCommitCounts(log, prefix),
    trackedFiles: parseTrackedFiles(tracked, prefix),
  };
}

export function churnFor(churn: ChurnData, file: string): number | null {
  if (!churn.trackedFiles.has(file)) return null;
  return churn.commitsByFile.get(file) ?? 0;
}
