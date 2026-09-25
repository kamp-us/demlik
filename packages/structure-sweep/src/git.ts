import { execFileSync } from "node:child_process";

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
