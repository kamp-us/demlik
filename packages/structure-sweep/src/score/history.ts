import { git } from "../git.js";
import type { ChangeSet } from "./score.js";

export interface HistoryOptions {
  /** Where history is read back from (default `HEAD`). */
  readonly ref?: string;
  /** Anything `git log --since` takes. */
  readonly since?: string;
  /** Keep only commits whose subject ends in `(#N)`, the squash-merge shape. */
  readonly prOnly?: boolean;
}

const RECORD = "\x1e";
const PR_SUBJECT = /\(#\d+\)$/;

/** One change set per non-merge commit reachable from `ref`: the paths it touched. */
export function readChangeSets(
  root: string,
  options: HistoryOptions = {},
): ChangeSet[] {
  const out = git(root, [
    "-c",
    "core.quotepath=off",
    "log",
    options.ref ?? "HEAD",
    "--no-merges",
    "--name-only",
    `--format=${RECORD}%s`,
    ...(options.since === undefined ? [] : [`--since=${options.since}`]),
    "--",
  ]);
  return out
    .split(RECORD)
    .slice(1)
    .map((record) => record.split("\n"))
    .filter(
      ([subject]) => !options.prOnly || PR_SUBJECT.test((subject ?? "").trim()),
    )
    .map(([, ...files]) => files.filter(Boolean));
}
