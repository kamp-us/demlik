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
 * `git cat-file --batch` subprocess however many paths there are. `-z` takes the names
 * NUL-separated, so a space, a newline or a non-ASCII byte in a path is read as itself. A path the
 * tree does not hold, or one that is not a file, throws naming it: it never reads as empty text.
 */
export function blobsAt(
  cwd: string,
  ref: string,
  paths: readonly string[],
): Map<string, string> {
  const blobs = new Map<string, string>();
  const unique = [...new Set(paths)];
  if (unique.length === 0) return blobs;
  const result = spawnSync("git", ["cat-file", "--batch", "-z"], {
    cwd,
    input: unique.map((path) => `${ref}:${path}\0`).join(""),
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
