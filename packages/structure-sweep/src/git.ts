import { execFileSync } from "node:child_process";

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
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
