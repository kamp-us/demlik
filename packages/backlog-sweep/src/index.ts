/**
 * @packageDocumentation
 * `@demlik/backlog-sweep` — the `backlog-sweep` bin's pieces as functions. `runBacklogSweep` and
 * `findDuplicateGroups` take their issues and their Jev client as arguments, so a caller (or a test)
 * can run them without GitHub or Jev.
 */

export {
  type CandidatePair,
  type ConfirmedPair,
  candidatePairs,
  DEFAULT_NEIGHBOURS,
  type DuplicateGroup,
  type DuplicateOptions,
  type DuplicateReport,
  findDuplicateGroups,
} from "./duplicates.js";
export { type Candidate, type Evidence, gatherEvidence } from "./evidence.js";
export {
  type ClosedIssue,
  fetchClosedIssues,
  fetchOpenIssues,
  type LinkedPull,
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
  type IssueAddress,
  type PullRelation,
  pullRelation,
  type RelationSource,
} from "./relation.js";
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
  type CloseBasis,
  CONFIDENCE_FLOOR,
  type ObsoleteFact,
  PAIR_CRITERIA,
  type PairQuestions,
  PROPOSAL_KINDS,
  type Proposal,
  pairQuestions,
  propose,
  type Questions,
  questions,
} from "./verdict.js";
