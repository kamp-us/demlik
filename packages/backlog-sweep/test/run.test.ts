import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Candidate } from "../src/evidence.js";
import type { OpenIssue } from "../src/github.js";
import type { RepoSnapshot } from "../src/repo.js";
import { runBacklogSweep } from "../src/run.js";

const snapshot: RepoSnapshot = {
  ref: "origin/main",
  files: new Set(),
  dirs: new Set(),
  topLevel: new Set(),
  commitsByIssue: new Map(),
};

const open: OpenIssue = {
  number: 1,
  title: "t",
  body: "",
  url: "https://github.com/acme/widgets/issues/1",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-02T00:00:00Z",
  labels: [],
  comments: [],
  linkedPulls: [
    { number: 9, title: "pr 9", state: "merged", relation: "partial" },
  ],
  linkedIssues: [],
};

const VERDICTS = [
  "still_needed",
  "already_done",
  "obsolete",
  "duplicate",
  "unclear",
] as const;
const PAIRS = ["duplicate", "related", "different"] as const;

const choice = (key: string, keys: readonly string[]) => ({
  type: "choice",
  choice: key,
  confidence: 0.96,
  probabilities: Object.fromEntries(keys.map((k) => [k, k === key ? 0.96 : 0])),
});

/** A verdict file holding one cached row for `open`, unchanged since it was asked. */
function cachedRow(options: {
  readonly verdict: (typeof VERDICTS)[number];
  readonly candidate1: (typeof PAIRS)[number];
  readonly candidates: readonly Candidate[];
  readonly proposal: unknown;
}): string {
  const outPath = join(mkdtempSync(join(tmpdir(), "backlog-sweep-")), "v.json");
  const different = choice("different", PAIRS);
  writeFileSync(
    outPath,
    JSON.stringify([
      {
        number: open.number,
        title: open.title,
        url: open.url,
        labels: [],
        updatedAt: open.updatedAt,
        evidence: { candidates: options.candidates },
        answers: {
          verdict: choice(options.verdict, VERDICTS),
          candidate_1: choice(options.candidate1, PAIRS),
          candidate_2: different,
          candidate_3: different,
        },
        proposal: options.proposal,
        model: "jev-stub",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ]),
  );
  return outPath;
}

const notAskedAgain = async (): Promise<never> => {
  throw new Error("an unchanged issue is not asked again");
};

describe("runBacklogSweep", () => {
  it("re-proposes a cached row from fresh evidence instead of replaying its old close", async () => {
    const outPath = cachedRow({
      verdict: "already_done",
      candidate1: "different",
      candidates: [],
      proposal: { kind: "close", reason: "already_done", confidence: 0.96 },
    });
    const rows = await runBacklogSweep({
      snapshot,
      open: [open],
      closed: [],
      jev: notAskedAgain,
      outPath,
    });
    expect(rows[0]?.proposal).toMatchObject({
      kind: "verify",
      linkedPullRequests: open.linkedPulls,
    });
  });

  it("keeps the candidates a cached answer judged when the index now ranks another issue first", async () => {
    const judged: Candidate = {
      number: 2,
      title: "widget crashes on save",
      state: "open",
      excerpt: "",
    };
    const outPath = cachedRow({
      verdict: "duplicate",
      candidate1: "duplicate",
      candidates: [judged],
      proposal: { kind: "close_duplicate", of: 2, confidence: 0.96 },
    });
    // #2 has since closed out of the index and #3 is now #1's nearest neighbour: Jev never saw #3.
    const newcomer: OpenIssue = {
      ...open,
      number: 3,
      title: "widget crashes on save",
      url: "https://github.com/acme/widgets/issues/3",
      linkedPulls: [],
    };
    const rows = await runBacklogSweep({
      snapshot,
      open: [{ ...open, title: "widget crashes on save" }, newcomer],
      closed: [],
      jev: notAskedAgain,
      outPath,
    });
    expect(rows[0]?.proposal).toEqual({
      kind: "close_duplicate",
      of: 2,
      confidence: 0.96,
    });
    expect(rows[0]?.evidence.candidates).toEqual([judged]);
    expect(rows[0]?.evidence.linkedPullRequests).toEqual(open.linkedPulls);
  });
});
