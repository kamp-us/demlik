import type { ClosedIssue, LinkedPull, OpenIssue } from "./github.js";
import { mentionedPaths, pathExists, type RepoSnapshot } from "./repo.js";
import { TfIdf } from "./similarity.js";

export const CANDIDATE_COUNT = 3;

export interface Candidate {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed-completed" | "closed-not-planned";
  readonly excerpt: string;
}

export type Evidence = {
  readonly issue: {
    readonly number: number;
    readonly title: string;
    readonly labels: readonly string[];
    readonly openedAt: string;
    readonly lastActivityAt: string;
    readonly body: string;
    readonly recentComments: readonly {
      readonly author: string;
      readonly body: string;
    }[];
  };
  readonly evidence: {
    readonly mentionedPathsStillOnMain: readonly string[];
    readonly mentionedPathsGoneFromMain: readonly string[];
    /** True only when the issue mentions at least one path and every one is gone from the ref. */
    readonly allMentionedPathsGone: boolean;
    readonly linkedPullRequests: readonly LinkedPull[];
    /** True only when the issue has a linked pull request and every one was closed without merging. */
    readonly linkedPullRequestClosedUnmerged: boolean;
    readonly linkedIssues: readonly {
      number: number;
      title: string;
      state: string;
    }[];
    readonly commitsOnMainReferencingThisIssue: readonly string[];
    readonly candidates: readonly Candidate[];
  };
};

const BODY_LIMIT = 2500;
const COMMENT_LIMIT = 400;
const EXCERPT_LIMIT = 500;

export function clip(text: string, limit: number): string {
  const flat = text.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (flat.length <= limit) return flat;
  return `${Array.from(flat).slice(0, limit).join("")}…`;
}

function closedState(reason: string | null | undefined): Candidate["state"] {
  return reason === "NOT_PLANNED" || reason === "DUPLICATE"
    ? "closed-not-planned"
    : "closed-completed";
}

export function buildIndex(
  open: readonly OpenIssue[],
  closed: readonly ClosedIssue[],
): TfIdf {
  return new TfIdf([
    ...open.map((i) => ({
      id: i.number,
      text: `${i.title} ${i.title} ${clip(i.body, 600)}`,
    })),
    ...closed.map((i) => ({ id: i.number, text: `${i.title} ${i.title}` })),
  ]);
}

export function gatherEvidence(
  issue: OpenIssue,
  repo: RepoSnapshot,
  index: TfIdf,
  openByNumber: ReadonlyMap<number, OpenIssue>,
  closedByNumber: ReadonlyMap<number, ClosedIssue>,
): Evidence {
  const paths = mentionedPaths(
    `${issue.body}\n${issue.comments.map((c) => c.body).join("\n")}`,
    repo.topLevel,
  );
  const still = paths.filter((p) => pathExists(repo, p));
  const gone = paths.filter((p) => !pathExists(repo, p));
  const candidates: Candidate[] = [];
  for (const hit of index.nearest(issue.number, CANDIDATE_COUNT * 3)) {
    if (candidates.length === CANDIDATE_COUNT) break;
    const open = openByNumber.get(hit.id);
    if (open !== undefined) {
      candidates.push({
        number: open.number,
        title: open.title,
        state: "open",
        excerpt: clip(open.body, EXCERPT_LIMIT),
      });
      continue;
    }
    const closed = closedByNumber.get(hit.id);
    if (closed !== undefined) {
      candidates.push({
        number: closed.number,
        title: closed.title,
        state: closedState(closed.stateReason),
        excerpt: "",
      });
    }
  }
  return {
    issue: {
      number: issue.number,
      title: issue.title,
      labels: issue.labels,
      openedAt: issue.createdAt.slice(0, 10),
      lastActivityAt: issue.updatedAt.slice(0, 10),
      body: clip(issue.body, BODY_LIMIT),
      recentComments: issue.comments
        .slice(-2)
        .map((c) => ({ author: c.author, body: clip(c.body, COMMENT_LIMIT) })),
    },
    evidence: {
      mentionedPathsStillOnMain: still,
      mentionedPathsGoneFromMain: gone,
      allMentionedPathsGone: paths.length > 0 && still.length === 0,
      linkedPullRequests: issue.linkedPulls,
      linkedPullRequestClosedUnmerged:
        issue.linkedPulls.length > 0 &&
        issue.linkedPulls.every((p) => p.state === "closed-unmerged"),
      linkedIssues: issue.linkedIssues.map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state === "OPEN" ? "open" : closedState(i.stateReason),
      })),
      commitsOnMainReferencingThisIssue: (
        repo.commitsByIssue.get(issue.number) ?? []
      ).slice(0, 8),
      candidates,
    },
  };
}
