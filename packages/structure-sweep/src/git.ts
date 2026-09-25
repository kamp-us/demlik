import { execFileSync, spawnSync } from "node:child_process";

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Where tracked paths are read from: the tree `ref` names, or the index (`git ls-files`). */
export type TrackedIn = { readonly ref: string } | "index";

/**
 * Every tracked path under `scope` (the whole repository when omitted), exactly as git stores it.
 * `-z` turns `core.quotePath` quoting off and survives a newline in a name, so a non-ASCII path
 * comes back as itself rather than as a C-quoted, octal-escaped string no other listing matches.
 */
export function trackedPaths(
  cwd: string,
  from: TrackedIn,
  scope?: string,
): string[] {
  const list =
    from === "index"
      ? ["ls-files", "-z"]
      : ["ls-tree", "-r", "-z", "--name-only", from.ref];
  return git(cwd, [...list, ...(scope === undefined ? [] : ["--", scope])])
    .split("\0")
    .filter(Boolean);
}

/**
 * The subset of `paths` git ignores, each exactly as given. `check-ignore` exits 1 when none is
 * ignored, so that is an empty set; any other failure throws rather than reading as "nothing
 * ignored". `-z` both ways keeps a non-ASCII or newline-holding path unquoted.
 */
export function ignoredPaths(
  cwd: string,
  paths: readonly string[],
): Set<string> {
  const result = spawnSync("git", ["check-ignore", "-z", "--stdin"], {
    cwd,
    input: paths.map((path) => `${path}\0`).join(""),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status === 1) return new Set();
  if (result.status !== 0)
    throw new Error(
      `git check-ignore failed in ${cwd} (${result.status ?? result.signal}): ${result.stderr.trim()}`,
    );
  return new Set(result.stdout.split("\0").filter(Boolean));
}

/** One non-merge commit: its subject line and every path it touched, exactly as git stores them. */
export interface CommitPaths {
  readonly subject: string;
  readonly paths: readonly string[];
}

const RECORD = "\x1e";

/**
 * Every non-merge commit reachable from `ref` — only those after `since` when given, which takes
 * anything `git log --since` does — newest first. `-z` keeps paths unquoted, as in `trackedPaths`.
 */
export function commitPaths(
  cwd: string,
  options: { readonly ref: string; readonly since?: string },
): CommitPaths[] {
  const out = git(cwd, [
    "log",
    options.ref,
    "--no-merges",
    "-z",
    "--name-only",
    `--format=${RECORD}%s`,
    ...(options.since === undefined ? [] : [`--since=${options.since}`]),
    "--",
  ]);
  // Each record reads `<RECORD><subject>\0`, then, when the commit touched a path, `\n` and every
  // path followed by `\0`.
  return out
    .split(RECORD)
    .slice(1)
    .map((record) => {
      const end = record.indexOf("\0");
      return {
        subject: record.slice(0, end),
        paths: record
          .slice(end + 1)
          .replace(/^\n/, "")
          .split("\0")
          .filter(Boolean),
      };
    });
}

/** The repository the command runs in: the top of the git checkout holding `cwd`. */
export function repoRootOf(cwd: string): string {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new Error(
      `${cwd} is not inside a git checkout; run from the repository you are sweeping`,
    );
  }
}
