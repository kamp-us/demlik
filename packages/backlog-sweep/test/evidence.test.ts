import { describe, expect, it } from "vitest";
import { buildIndex, gatherEvidence } from "../src/evidence.js";
import type { LinkedPull, OpenIssue } from "../src/github.js";
import type { RepoSnapshot } from "../src/repo.js";

const snapshot: RepoSnapshot = {
  ref: "origin/main",
  files: new Set(["lib/kept.ts"]),
  dirs: new Set(["lib"]),
  topLevel: new Set(["lib"]),
  commitsByIssue: new Map(),
};

function issue(
  body: string,
  linkedPulls: readonly LinkedPull[] = [],
): OpenIssue {
  return {
    number: 1,
    title: "t",
    body,
    url: "https://github.com/acme/widgets/issues/1",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    labels: [],
    comments: [],
    linkedPulls,
    linkedIssues: [],
  };
}

const facts = (subject: OpenIssue) =>
  gatherEvidence(
    subject,
    snapshot,
    buildIndex([subject], []),
    new Map([[subject.number, subject]]),
    new Map(),
  ).evidence;

const pull = (number: number, state: LinkedPull["state"]): LinkedPull => ({
  number,
  title: `pr ${number}`,
  state,
  relation: "partial",
});

describe("allMentionedPathsGone", () => {
  it("is false when the issue mentions no path", () => {
    expect(facts(issue("nothing here")).allMentionedPathsGone).toBe(false);
  });

  it("is false when only some mentioned paths are gone", () => {
    expect(
      facts(issue("see lib/kept.ts and lib/gone.ts")).allMentionedPathsGone,
    ).toBe(false);
  });

  it("is true when every mentioned path is gone", () => {
    expect(
      facts(issue("see lib/gone.ts and lib/old/")).allMentionedPathsGone,
    ).toBe(true);
  });
});

describe("linkedPullRequestClosedUnmerged", () => {
  it("is false with no linked pull request", () => {
    expect(facts(issue("")).linkedPullRequestClosedUnmerged).toBe(false);
  });

  it("is true when the one linked pull request closed unmerged", () => {
    expect(
      facts(issue("", [pull(5, "closed-unmerged")]))
        .linkedPullRequestClosedUnmerged,
    ).toBe(true);
  });

  it("is false when a closed-unmerged pull request sits beside a merged one", () => {
    expect(
      facts(issue("", [pull(5, "closed-unmerged"), pull(6, "merged")]))
        .linkedPullRequestClosedUnmerged,
    ).toBe(false);
  });
});

describe("linkedPullRequests", () => {
  it("carries each pull request's state and relation", () => {
    const closing: LinkedPull = {
      number: 7,
      title: "pr 7",
      state: "merged",
      relation: "closes",
    };
    expect(facts(issue("", [closing])).linkedPullRequests).toEqual([closing]);
  });
});
