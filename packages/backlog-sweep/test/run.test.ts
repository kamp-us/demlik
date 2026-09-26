import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

const choice = (key: string, keys: readonly string[]) => ({
  type: "choice",
  choice: key,
  confidence: 0.96,
  probabilities: Object.fromEntries(keys.map((k) => [k, k === key ? 0.96 : 0])),
});

describe("runBacklogSweep", () => {
  it("re-proposes a cached row from fresh evidence instead of replaying its old close", async () => {
    const outPath = join(
      mkdtempSync(join(tmpdir(), "backlog-sweep-")),
      "v.json",
    );
    const pair = choice("different", ["duplicate", "related", "different"]);
    writeFileSync(
      outPath,
      JSON.stringify([
        {
          number: 1,
          title: "t",
          url: open.url,
          labels: [],
          updatedAt: open.updatedAt,
          evidence: {},
          answers: {
            verdict: choice("already_done", [
              "still_needed",
              "already_done",
              "obsolete",
              "duplicate",
              "unclear",
            ]),
            candidate_1: pair,
            candidate_2: pair,
            candidate_3: pair,
          },
          proposal: { kind: "close", reason: "already_done", confidence: 0.96 },
          model: "jev-stub",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      ]),
    );
    const rows = await runBacklogSweep({
      snapshot,
      open: [open],
      closed: [],
      jev: async () => {
        throw new Error("an unchanged issue is not asked again");
      },
      outPath,
    });
    expect(rows[0]?.proposal).toMatchObject({
      kind: "verify",
      linkedPullRequests: open.linkedPulls,
    });
  });
});
