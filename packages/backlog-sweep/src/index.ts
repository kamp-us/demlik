/**
 * @packageDocumentation
 * `@demlik/backlog-sweep` — the `backlog-sweep` bin's pieces as functions. `runBacklogSweep` takes its
 * issues and its Jev client as arguments, so a caller (or a test) can run it without GitHub or Jev.
 */

export { type Candidate, type Evidence, gatherEvidence } from "./evidence.js";
export {
  type ClosedIssue,
  fetchClosedIssues,
  fetchOpenIssues,
  type OpenIssue,
} from "./github.js";
export {
  DEFAULT_MODEL,
  fetchPost,
  httpJevClient,
  JevAskError,
  type JevClient,
} from "./jev.js";
export {
  mentionedPaths,
  type RepoSnapshot,
  repoFromRemoteUrl,
  resolveRepo,
  snapshotRepo,
} from "./repo.js";
export { type BacklogSweepOptions, type Row, runBacklogSweep } from "./run.js";
export {
  type Answers,
  CONFIDENCE_FLOOR,
  type Proposal,
  propose,
  type Questions,
  questions,
} from "./verdict.js";
