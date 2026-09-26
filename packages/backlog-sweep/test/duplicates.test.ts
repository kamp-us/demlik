import type { JevOk, JevState } from "@demlik/tea/jev";
import { describe, expect, it } from "vitest";
import { candidatePairs, findDuplicateGroups } from "../src/duplicates.js";
import type { OpenIssue } from "../src/github.js";
import type { JevClient } from "../src/jev.js";
import { CONFIDENCE_FLOOR, type PairQuestions } from "../src/verdict.js";

type Choice = "duplicate" | "related" | "different";

function issue(number: number, labels: readonly string[] = []): OpenIssue {
  return {
    number,
    title: `widget renderer crash ${number}`,
    body: "the widget renderer crashes on resize",
    url: `https://github.com/acme/widgets/issues/${number}`,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    labels,
    comments: [],
    linkedPulls: [],
    linkedIssues: [],
  };
}

/** A Jev stand-in with no network and no key: it answers each pair from `table`, `different` otherwise. */
function stubJev(
  table: Readonly<Record<string, readonly [Choice, number]>>,
): JevClient<PairQuestions> & { readonly asked: string[] } {
  const asked: string[] = [];
  const client = async (state: JevState): Promise<JevOk<PairQuestions>> => {
    const { left, right } = state as {
      left: { number: number };
      right: { number: number };
    };
    const key = `${left.number}:${right.number}`;
    asked.push(key);
    const [choice, confidence] = table[key] ?? ["different", 1];
    return {
      answers: {
        pair: {
          type: "choice",
          choice,
          confidence,
          probabilities: {
            duplicate: 0,
            related: 0,
            different: 0,
            [choice]: confidence,
          },
        },
      },
      model: "jev-stub",
      usage: { input_tokens: 10, output_tokens: 1 },
      source: "port",
    };
  };
  return Object.assign(client, { asked });
}

describe("findDuplicateGroups", () => {
  const open = [issue(1), issue(2), issue(3), issue(4)];

  it("joins two confirmed pairs that share an issue into one group of three", async () => {
    const report = await findDuplicateGroups({
      open,
      jev: stubJev({ "1:2": ["duplicate", 0.9], "2:3": ["duplicate", 0.95] }),
    });
    expect(report.groups).toEqual([
      {
        issues: [1, 2, 3].map((n) => ({
          number: n,
          title: `widget renderer crash ${n}`,
          url: `https://github.com/acme/widgets/issues/${n}`,
        })),
        pairs: [
          { a: 1, b: 2, confidence: 0.9 },
          { a: 2, b: 3, confidence: 0.95 },
        ],
      },
    ]);
    const grouped = report.groups.flatMap((g) => g.issues.map((i) => i.number));
    expect(grouped).not.toContain(4);
  });

  it("merges nothing on a related answer or a duplicate below the floor", async () => {
    const report = await findDuplicateGroups({
      open,
      jev: stubJev({
        "1:2": ["related", 0.99],
        "3:4": ["duplicate", CONFIDENCE_FLOOR - 0.01],
      }),
    });
    expect(report.groups).toEqual([]);
  });

  it("asks one question per candidate pair and never about an excluded issue", async () => {
    const jev = stubJev({});
    const report = await findDuplicateGroups({
      open: [...open, issue(5, ["type:epic"])],
      jev,
      excludeLabels: ["type:epic"],
    });
    expect(jev.asked).toHaveLength(report.candidates);
    expect(jev.asked.some((k) => k.split(":").includes("5"))).toBe(false);
  });

  it("lists a pair whose call failed as unanswered, confirming nothing", async () => {
    const report = await findDuplicateGroups({
      open: [issue(1), issue(2)],
      jev: async () => {
        throw new Error("down");
      },
    });
    expect(report.unanswered).toEqual([{ a: 1, b: 2 }]);
    expect(report.groups).toEqual([]);
  });
});

describe("candidatePairs", () => {
  it("never pairs an issue with itself or emits one unordered pair twice", () => {
    const pairs = candidatePairs([issue(1), issue(2), issue(3), issue(4)], 5);
    expect(pairs.every(({ a, b }) => a < b)).toBe(true);
    expect(new Set(pairs.map(({ a, b }) => `${a}:${b}`)).size).toBe(
      pairs.length,
    );
    expect(pairs).toHaveLength(6);
  });

  it("takes only the nearest neighbours the count allows", () => {
    const pairs = candidatePairs([issue(1), issue(2), issue(3), issue(4)], 1);
    expect(pairs.length).toBeLessThanOrEqual(4);
    expect(pairs.length).toBeGreaterThan(0);
  });
});
