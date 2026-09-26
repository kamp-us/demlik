import { describe, expect, it } from "vitest";
import type { Evidence } from "../src/evidence.js";
import type { LinkedPull } from "../src/github.js";
import {
  type Answers,
  CONFIDENCE_FLOOR,
  type Proposal,
  propose,
} from "../src/verdict.js";

type Pair = "duplicate" | "related" | "different";

function evidence(
  candidates: readonly number[],
  facts: Partial<
    Pick<
      Evidence["evidence"],
      | "linkedPullRequests"
      | "allMentionedPathsGone"
      | "linkedPullRequestClosedUnmerged"
      | "commitsOnMainReferencingThisIssue"
    >
  > = {},
): Evidence {
  return {
    issue: {
      number: 1,
      title: "t",
      labels: [],
      openedAt: "2026-09-01",
      lastActivityAt: "2026-09-01",
      body: "",
      recentComments: [],
    },
    evidence: {
      mentionedPathsStillOnMain: [],
      mentionedPathsGoneFromMain: [],
      allMentionedPathsGone: false,
      linkedPullRequests: [],
      linkedPullRequestClosedUnmerged: false,
      linkedIssues: [],
      commitsOnMainReferencingThisIssue: [],
      candidates: candidates.map((number) => ({
        number,
        title: `#${number}`,
        state: "open",
        excerpt: "",
      })),
      ...facts,
    },
  };
}

const pull = (
  number: number,
  state: LinkedPull["state"],
  relation: LinkedPull["relation"],
): LinkedPull => ({ number, title: `pr ${number}`, state, relation });

function pair(choice: Pair, confidence: number) {
  return {
    type: "choice",
    choice,
    confidence,
    probabilities: {
      duplicate: 0,
      related: 0,
      different: 0,
      [choice]: confidence,
    },
  } as const;
}

function answers(
  verdict: Answers["verdict"]["choice"],
  confidence: number,
  pairs: readonly [Pair, number][] = [],
): Answers {
  const [c1 = ["different", 1], c2 = ["different", 1], c3 = ["different", 1]] =
    pairs;
  return {
    verdict: {
      type: "choice",
      choice: verdict,
      confidence,
      probabilities: {
        still_needed: 0,
        already_done: 0,
        obsolete: 0,
        duplicate: 0,
        unclear: 0,
        [verdict]: confidence,
      },
    },
    candidate_1: pair(...c1),
    candidate_2: pair(...c2),
    candidate_3: pair(...c3),
  };
}

describe("propose", () => {
  it("sends a verdict below the confidence floor to review", () => {
    expect(
      propose(evidence([]), answers("obsolete", CONFIDENCE_FLOOR - 0.01)),
    ).toEqual({
      kind: "review",
      why: `obsolete at confidence ${(CONFIDENCE_FLOOR - 0.01).toFixed(2)}`,
    });
  });

  it("keeps a confident still_needed", () => {
    expect(propose(evidence([]), answers("still_needed", 0.95))).toEqual({
      kind: "keep",
      confidence: 0.95,
    });
  });

  describe("already_done", () => {
    it("verifies when the only merged pull request is partial", () => {
      const partial = pull(40, "merged", "partial");
      expect(
        propose(
          evidence([], {
            linkedPullRequests: [partial],
            commitsOnMainReferencingThisIssue: ["feat: part one (#1)"],
          }),
          answers("already_done", 0.96),
        ),
      ).toEqual({
        kind: "verify",
        confidence: 0.96,
        linkedPullRequests: [partial],
        commitsReferencingIssue: ["feat: part one (#1)"],
      });
    });

    it("closes on a merged pull request that closes the issue, naming it", () => {
      expect(
        propose(
          evidence([], {
            linkedPullRequests: [
              pull(40, "merged", "partial"),
              pull(41, "merged", "closes"),
            ],
          }),
          answers("already_done", 0.96),
        ),
      ).toEqual({
        kind: "close",
        reason: "already_done",
        basis: { kind: "merged_closing_pull_request", pullRequest: 41 },
        confidence: 0.96,
      });
    });

    it("verifies with no linked pull request", () => {
      expect(propose(evidence([]), answers("already_done", 0.96))).toEqual({
        kind: "verify",
        confidence: 0.96,
        linkedPullRequests: [],
        commitsReferencingIssue: [],
      });
    });

    it("verifies a closing pull request that is still open", () => {
      expect(
        propose(
          evidence([], { linkedPullRequests: [pull(41, "open", "closes")] }),
          answers("already_done", 0.96),
        ).kind,
      ).toBe("verify");
    });

    it("verifies below the floor even beside a merged closing pull request", () => {
      expect(
        propose(
          evidence([], { linkedPullRequests: [pull(41, "merged", "closes")] }),
          answers("already_done", CONFIDENCE_FLOOR - 0.01),
        ).kind,
      ).toBe("verify");
    });
  });

  describe("obsolete", () => {
    it("closes when every mentioned path is gone, naming that fact", () => {
      expect(
        propose(
          evidence([], { allMentionedPathsGone: true }),
          answers("obsolete", 0.9),
        ),
      ).toEqual({
        kind: "close",
        reason: "obsolete",
        basis: { kind: "all_mentioned_paths_gone" },
        confidence: 0.9,
      });
    });

    it("closes when every linked pull request closed unmerged, naming that fact", () => {
      expect(
        propose(
          evidence([], { linkedPullRequestClosedUnmerged: true }),
          answers("obsolete", 0.9),
        ),
      ).toEqual({
        kind: "close",
        reason: "obsolete",
        basis: { kind: "linked_pull_requests_closed_unmerged" },
        confidence: 0.9,
      });
    });

    it("never closes when neither fact holds", () => {
      expect(propose(evidence([]), answers("obsolete", 0.99))).toEqual({
        kind: "review",
        why: "obsolete, but neither computed fact holds: not every mentioned path is gone, and not every linked pull request closed unmerged",
      });
    });
  });

  it("closes a duplicate against the most confident duplicate candidate", () => {
    const proposal = propose(
      evidence([10, 20, 30]),
      answers("duplicate", 0.9, [
        ["duplicate", 0.85],
        ["duplicate", 0.95],
        ["related", 0.9],
      ]),
    );
    expect(proposal).toEqual({
      kind: "close_duplicate",
      of: 20,
      confidence: 0.9,
    });
  });

  it("reviews a duplicate verdict when no candidate pair clears the floor", () => {
    expect(
      propose(
        evidence([10]),
        answers("duplicate", 0.9, [["duplicate", CONFIDENCE_FLOOR - 0.1]]),
      ),
    ).toEqual({
      kind: "review",
      why: "duplicate verdict without a confident pair match",
    });
  });

  it("ignores a duplicate answer at a slot with no candidate", () => {
    expect(
      propose(evidence([]), answers("duplicate", 0.9, [["duplicate", 0.99]])),
    ).toEqual({
      kind: "review",
      why: "duplicate verdict without a confident pair match",
    });
  });

  it("reviews unclear at any confidence", () => {
    expect(propose(evidence([]), answers("unclear", 0.2))).toEqual({
      kind: "review",
      why: "Jev found the evidence insufficient",
    });
  });
});

describe("Proposal", () => {
  it("admits a close only with the computed basis its reason allows", () => {
    // @ts-expect-error a close with no basis does not type-check
    const unbased: Proposal = {
      kind: "close",
      reason: "obsolete",
      confidence: 0.9,
    };
    const crossed: Proposal = {
      kind: "close",
      reason: "already_done",
      // @ts-expect-error an already_done close stands only on a merged closing pull request
      basis: { kind: "all_mentioned_paths_gone" },
      confidence: 0.9,
    };
    expect([unbased, crossed]).toHaveLength(2);
  });
});
