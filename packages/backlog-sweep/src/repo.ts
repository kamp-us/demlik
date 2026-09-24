import { execFileSync } from "node:child_process";

export interface RepoSnapshot {
  readonly ref: string;
  readonly files: ReadonlySet<string>;
  readonly dirs: ReadonlySet<string>;
  /** The folders at the root of the tree — what a path written in an issue starts with. */
  readonly topLevel: ReadonlySet<string>;
  readonly commitsByIssue: ReadonlyMap<number, readonly string[]>;
}

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const ISSUE_REF = /(?:^|[\s(])#(\d{2,6})\b/g;

export function snapshotRepo(cwd: string, ref: string): RepoSnapshot {
  const files = new Set(
    git(cwd, ["ls-tree", "-r", "--name-only", ref]).split("\n").filter(Boolean),
  );
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++)
      dirs.add(parts.slice(0, i).join("/"));
  }
  const topLevel = new Set([...dirs].filter((d) => !d.includes("/")));
  const commitsByIssue = new Map<number, string[]>();
  for (const record of git(cwd, ["log", ref, "--format=%s%x00%b%x1e"]).split(
    "\x1e",
  )) {
    const [subject = "", body = ""] = record.trim().split("\x00");
    for (const match of `${subject}\n${body}`.matchAll(ISSUE_REF)) {
      const number = Number(match[1]);
      const list = commitsByIssue.get(number) ?? [];
      if (!list.includes(subject)) list.push(subject);
      commitsByIssue.set(number, list);
    }
  }
  return { ref, files, dirs, topLevel, commitsByIssue };
}

const PATH_LIKE = /(?<![\w/.-])([\w.@-]+\/[\w@./[\]-]+)/g;

/**
 * Repo paths an issue mentions: a slash-separated token whose first segment is a folder at the root
 * of this repository's tree, so the vocabulary of paths is the repo's own and not a fixed list.
 */
export function mentionedPaths(
  text: string,
  topLevel: ReadonlySet<string>,
): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PATH_LIKE)) {
    const path = (match[1] ?? "").replace(/[.:,)]+$/, "").replace(/\/$/, "");
    const [head] = path.split("/");
    if (head !== undefined && topLevel.has(head) && path.split("/").length >= 2)
      found.add(path);
  }
  return [...found];
}

export function pathExists(snapshot: RepoSnapshot, path: string): boolean {
  const withoutLine = path.replace(/:\d+(?::\d+)?$/, "");
  return snapshot.files.has(withoutLine) || snapshot.dirs.has(withoutLine);
}

/** `owner/name` of a GitHub remote URL, in any of the forms git prints it. */
export function repoFromRemoteUrl(url: string): string | undefined {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
    url.trim(),
  );
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

/** The repository to sweep: `--repo` when given, else the cwd's `origin` remote. Never a default. */
export function resolveRepo(flag: string | undefined, cwd: string): string {
  if (flag !== undefined) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(flag))
      throw new Error(`--repo takes owner/name, got ${flag}`);
    return flag;
  }
  let url: string;
  try {
    url = git(cwd, ["remote", "get-url", "origin"]);
  } catch {
    throw new Error(
      "pass --repo owner/name; this checkout has no origin remote to read it from",
    );
  }
  const repo = repoFromRemoteUrl(url);
  if (repo === undefined) {
    throw new Error(
      `pass --repo owner/name; origin (${url.trim()}) is not a GitHub remote`,
    );
  }
  return repo;
}
