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
 * ignored, so that is an empty set; any other outcome throws rather than reading as "nothing
 * ignored" — including a spawn error, since an `EPIPE` means git exited before reading every path.
 * `-z` both ways keeps a non-ASCII or newline-holding path unquoted.
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
  if (result.error === undefined && result.status === 0)
    return new Set(result.stdout.split("\0").filter(Boolean));
  if (result.error === undefined && result.status === 1) return new Set();
  const exit = result.status ?? result.signal ?? "no exit";
  const reason = result.stderr?.trim() || result.error?.message || "";
  throw new Error(`git check-ignore failed in ${cwd} (${exit}): ${reason}`, {
    cause: result.error,
  });
}

const BLOB_HEADER = /^[0-9a-f]+ blob (\d+)$/;

/**
 * The text of every `paths` entry in the tree `ref` names, keyed by path in the order given, read in one
 * `git cat-file --batch` subprocess however many paths there are. Names go in one per line, not
 * NUL-separated: `--batch -z` needs git 2.38, and every other read here runs on any git. A space or
 * a non-ASCII byte in a path is read as itself; a path holding a newline cannot be, so it throws
 * naming it before git runs. A path the tree does not hold, or one that is not a file, throws naming
 * it too: it never reads as empty text.
 */
export function blobsAt(
  cwd: string,
  ref: string,
  paths: readonly string[],
): Map<string, string> {
  const blobs = new Map<string, string>();
  const unique = [...new Set(paths)];
  if (unique.length === 0) return blobs;
  const unreadable = unique.find((path) => path.includes("\n"));
  if (unreadable !== undefined)
    throw new Error(
      `${ref}:${JSON.stringify(unreadable)} holds a newline, which git cat-file --batch cannot read without -z (git 2.38+); rename it to sweep ${cwd}`,
    );
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd,
    input: unique.map((path) => `${ref}:${path}\n`).join(""),
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    const exit = result.status ?? result.signal ?? "no exit";
    const reason =
      result.stderr?.toString().trim() || result.error?.message || "";
    throw new Error(`git cat-file failed in ${cwd} (${exit}): ${reason}`, {
      cause: result.error,
    });
  }
  // Each answer is `<oid> blob <size>\n<size bytes>\n`, or `<object> <problem>\n` when git cannot
  // give that object's content; answers come in the order the names went in.
  const out = result.stdout;
  let at = 0;
  for (const path of unique) {
    const eol = out.indexOf(0x0a, at);
    const header = eol === -1 ? "" : out.toString("utf8", at, eol);
    const size = BLOB_HEADER.exec(header)?.[1];
    if (size === undefined)
      throw new Error(`${ref}:${path} is not a file in ${cwd}`);
    const start = eol + 1;
    const end = start + Number(size);
    blobs.set(path, out.toString("utf8", start, end));
    at = end + 1;
  }
  return blobs;
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

/**
 * Every tracked path with a staged or unstaged change, exactly as git stores it; untracked files
 * are left out. A rename or copy is named by its destination; its source follows as a field of its
 * own, which is skipped.
 */
export function uncommittedPaths(cwd: string): string[] {
  const fields = git(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=no",
  ]).split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    paths.push(field.slice(3));
    if (/^[RC]|^.[RC]/.test(field)) i += 1;
  }
  return paths;
}

/** Every untracked path under `scope` that git does not ignore, exactly as git stores it. */
export function untrackedPaths(cwd: string, scope: string): string[] {
  return git(cwd, [
    "ls-files",
    "-z",
    "--others",
    "--exclude-standard",
    "--",
    scope,
  ])
    .split("\0")
    .filter(Boolean);
}

/** Every path the index changes against HEAD. */
export function stagedPaths(cwd: string): string[] {
  return git(cwd, ["diff", "--cached", "--name-only", "-z"])
    .split("\0")
    .filter(Boolean);
}

/** The renames `commit` made from its parent with content unchanged. */
export function exactRenames(
  cwd: string,
  commit: string,
): { readonly from: string; readonly to: string }[] {
  const fields = git(cwd, [
    "diff-tree",
    "-r",
    "-z",
    "--no-commit-id",
    "--name-status",
    "-M100%",
    commit,
  ]).split("\0");
  const renames: { from: string; to: string }[] = [];
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]?.startsWith("R")) continue;
    const from = fields[i + 1];
    const to = fields[i + 2];
    if (from !== undefined && to !== undefined) renames.push({ from, to });
    i += 2;
  }
  return renames;
}
