import { describe, expect, it } from "vitest";
import type { Evidence } from "../src/evidence.js";
import { type Answers, CONFIDENCE_FLOOR, propose } from "../src/verdict.js";

type Pair = "duplicate" | "related" | "different";

function evidence(candidates: readonly number[]): Evidence {
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
      linkedPullRequests: [],
      linkedIssues: [],
      commitsOnMainReferencingThisIssue: [],
      candidates: candidates.map((number) => ({
        number,
        title: `#${number}`,
        state: "open",
        excerpt: "",
      })),
    },
  };
}

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
  it("sends anything below the confidence floor to review, whatever the verdict", () => {
    expect(
      propose(evidence([]), answers("already_done", CONFIDENCE_FLOOR - 0.01)),
    ).toEqual({
      kind: "review",
      why: `already_done at confidence ${(CONFIDENCE_FLOOR - 0.01).toFixed(2)}`,
    });
  });

  it("keeps a confident still_needed", () => {
    expect(propose(evidence([]), answers("still_needed", 0.95))).toEqual({
      kind: "keep",
      confidence: 0.95,
    });
  });

  it("closes a confident already_done or obsolete with its reason", () => {
    expect(propose(evidence([]), answers("obsolete", 0.9))).toEqual({
      kind: "close",
      reason: "obsolete",
      confidence: 0.9,
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
