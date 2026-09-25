import { commitPaths } from "../git.js";
import type { ChangeSet } from "./score.js";

export interface HistoryOptions {
  /** Where history is read back from (default `HEAD`). */
  readonly ref?: string;
  /** Anything `git log --since` takes. */
  readonly since?: string;
  /** Keep only commits whose subject ends in `(#N)`, the squash-merge shape. */
  readonly prOnly?: boolean;
}

const PR_SUBJECT = /\(#\d+\)$/;

/** One change set per non-merge commit reachable from `ref`: the paths it touched. */
export function readChangeSets(
  root: string,
  options: HistoryOptions = {},
): ChangeSet[] {
  return commitPaths(root, { ref: options.ref ?? "HEAD", since: options.since })
    .filter(({ subject }) => !options.prOnly || PR_SUBJECT.test(subject.trim()))
    .map(({ paths }) => paths);
}
