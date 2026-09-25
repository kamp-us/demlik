import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scoreCommand } from "../src/score/cli.js";
import { readChangeSets } from "../src/score/history.js";
import { type ScoreRow, scoreCoChange } from "../src/score/score.js";
import { commit, repo, write } from "./helpers.js";

// Scope `a` holds features F and G across two leaf folders; scope `b` holds one more F file.
const row = (
  path: string,
  choice: string,
  confidence: number,
): ScoreRow & { hash: string } => ({
  path,
  scope: path.split("/")[0] as string,
  hash: "extra fields are ignored",
  answers: { feature: { choice, confidence } },
});

const ROWS = [
  row("a/x/1.ts", "F", 0.9),
  row("a/x/2.ts", "F", 0.5),
  row("a/y/3.ts", "F", 0.8),
  row("a/y/4.ts", "G", 0.95),
  row("a/y/5.ts", "G", 0.3),
  row("b/z/6.ts", "F", 0.85),
];

/**
 * one (#1):  1 3        → (1,3) co-change inside F
 * two (#2):  4 5 6      → (4,5) inside G; (4,6) (5,6) cross scope, never counted
 * three:     1 4        → (1,4) co-change across F and G; no PR suffix
 * four (#4): 2 README   → one labelled file, dropped
 */
function history(): string {
  const root = repo({ "README.md": "hi\n" });
  write(root, { "a/x/1.ts": "1", "a/y/3.ts": "3" });
  commit(root, "one (#1)");
  write(root, { "a/y/4.ts": "4", "a/y/5.ts": "5", "b/z/6.ts": "6" });
  commit(root, "two (#2)");
  write(root, { "a/x/1.ts": "1'", "a/y/4.ts": "4'" });
  commit(root, "three");
  write(root, { "a/x/2.ts": "2", "README.md": "hi again\n" });
  commit(root, "four (#4)");
  return root;
}

const close = (actual: number | null, expected: number) =>
  expect(actual).toBeCloseTo(expected, 12);

const feature = (report: ReturnType<typeof scoreCoChange>, key: string) =>
  report.features.find((f) => f.feature === key);

describe("scoreCoChange over a fixture history", () => {
  const root = history();

  it("scores overall, per feature and the leaf-folder baseline", () => {
    const r = scoreCoChange(ROWS, readChangeSets(root));
    expect(r.changeSets).toBe(3);
    expect(r.files).toBe(5);
    // predicted (1,3) (4,5); co-changed (1,3) (4,5) (1,4)
    expect(r.precision).toBe(1);
    close(r.recall, 2 / 3);
    close(r.f1, 0.8);
    expect(feature(r, "F")).toMatchObject({ precision: 1, recall: 0.5 });
    close(feature(r, "F")?.f1 ?? null, 2 / 3);
    expect(feature(r, "G")).toMatchObject({ precision: 1, recall: 0.5 });
    // leaf folders: a/y holds 3 4 5 → predicted (3,4) (3,5) (4,5), one hit
    close(r.baseline.precision, 1 / 3);
    close(r.baseline.recall, 1 / 3);
    close(r.baseline.f1, 1 / 3);
  });

  it("never pairs files across scopes", () => {
    // 6 shares F with 1 and 3 and changes with them, but sits in scope b. Counted, it would add
    // (1,6) (3,6) as predicted hits and (4,6) as a miss: precision 1, recall 3/6.
    const r = scoreCoChange(ROWS, [
      ["b/z/6.ts", "a/x/1.ts", "a/y/3.ts", "a/y/4.ts"],
    ]);
    expect(r.precision).toBe(1);
    close(r.recall, 1 / 3);
    expect(feature(r, "F")?.precision).toBe(1);
    close(feature(r, "F")?.recall ?? null, 1 / 3);
  });

  it("drops change sets past --max-files, leaving null where a denominator is zero", () => {
    const r = scoreCoChange(ROWS, readChangeSets(root), { maxFiles: 2 });
    expect(r.changeSets).toBe(2);
    expect(r).toMatchObject({ precision: 1, recall: 0.5 });
    expect(feature(r, "G")).toMatchObject({
      precision: null,
      recall: 0,
      f1: null,
    });
  });

  it("keeps only (#N) subjects under prOnly", () => {
    const r = scoreCoChange(ROWS, readChangeSets(root, { prOnly: true }));
    expect(r.changeSets).toBe(2);
    expect(r).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(feature(r, "F")).toMatchObject({ precision: 1, recall: 1, f1: 1 });
  });

  it("counts the confidence share against CONFIDENCE_FLOOR", () => {
    const r = scoreCoChange(ROWS, []);
    expect(r.confidence).toEqual({ confident: 4, rows: 6, share: 4 / 6 });
    expect(feature(r, "F")?.confidence).toEqual({
      confident: 3,
      rows: 4,
      share: 0.75,
    });
    expect(feature(r, "G")?.confidence).toEqual({
      confident: 1,
      rows: 2,
      share: 0.5,
    });
    expect(r).toMatchObject({ precision: null, recall: null, f1: null });
    expect(scoreCoChange([], []).confidence.share).toBeNull();
  });
});

describe("structure-sweep score", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes the JSON report and prints n/a for a null metric", () => {
    const root = history();
    write(root, { ".structure-sweep/verdicts.json": JSON.stringify(ROWS) });
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    scoreCommand(["--pr-only", "--max-files", "2"], root);

    const report = JSON.parse(
      readFileSync(join(root, ".structure-sweep/score.json"), "utf8"),
    );
    // only one (#1) survives: (1,3) in F, nothing for G
    expect(report).toMatchObject({ changeSets: 1, precision: 1, recall: 1 });
    expect(report.features[1]).toMatchObject({
      feature: "G",
      precision: null,
      recall: null,
      f1: null,
    });
    const table = String(out.mock.calls[0]?.[0]);
    expect(table).toContain("overall\t100.0\t100.0\t100.0\t66.7 (4/6)");
    expect(table).toContain("G\tn/a\tn/a\tn/a\t50.0 (1/2)");
  });
});
