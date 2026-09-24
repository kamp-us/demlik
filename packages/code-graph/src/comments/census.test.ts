import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assembleGraph } from "../extract/assemble.js";
import { loadCheapProject } from "../extract/project.js";
import { ThresholdsSchema } from "../schema.js";
import { loadCommentCensus } from "./census.js";
import { COMMENT_BUCKETS } from "./classify.js";
import { renderComments } from "./render.js";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "extract");

describe("comment census — one computation, not two", () => {
  it("totals.commentLines equals the Graph's stats.totalCommentLines", () => {
    const census = loadCommentCensus(FIXTURE);
    const graph = assembleGraph(loadCheapProject(FIXTURE), ThresholdsSchema.parse({}));

    expect(census.totals.commentLines).toBe(graph.stats.totalCommentLines);
    expect(census.totals.files).toBe(graph.stats.fileCount);
    expect(census.totals.loc).toBe(graph.stats.totalLoc);
  });

  it("agrees with the Graph file by file, not just in aggregate", () => {
    const census = loadCommentCensus(FIXTURE);
    const graph = assembleGraph(loadCheapProject(FIXTURE), ThresholdsSchema.parse({}));
    const perModule = new Map(graph.modules.map((m) => [m.file, m.commentLines]));

    for (const row of census.files) {
      expect(perModule.get(row.file)).toBe(row.commentLines);
    }
  });
});

describe("comment census — the numbers close", () => {
  it("buckets partition each file's comment lines exactly", () => {
    const census = loadCommentCensus(FIXTURE);
    for (const row of census.files) {
      const summed = COMMENT_BUCKETS.reduce((total, b) => total + row.buckets[b], 0);
      expect(summed).toBe(row.commentLines);
      expect(row.loc).toBe(row.codeLines + row.commentLines + row.blankLines);
    }
  });

  it("totals are the sum of the file rows, and the three classes close", () => {
    const census = loadCommentCensus(FIXTURE);
    const sum = (pick: (row: (typeof census.files)[number]) => number): number =>
      census.files.reduce((total, row) => total + pick(row), 0);

    expect(census.totals.loc).toBe(sum((r) => r.loc));
    expect(census.totals.codeLines).toBe(sum((r) => r.codeLines));
    expect(census.totals.blankLines).toBe(sum((r) => r.blankLines));
    expect(census.totals.commentLines).toBe(sum((r) => r.commentLines));
    expect(census.totals.mechanicalLines).toBe(sum((r) => r.mechanicalLines));
    expect(census.totals.protectedLines).toBe(sum((r) => r.protectedLines));
    expect(census.totals.proseLines).toBe(sum((r) => r.proseLines));

    expect(
      census.totals.mechanicalLines + census.totals.protectedLines + census.totals.proseLines,
    ).toBe(census.totals.commentLines);

    expect(census.totals.mechanicalLines).toBe(
      census.buckets.banner.lines + census.buckets["commented-out-code"].lines,
    );
    expect(census.totals.protectedLines).toBe(
      census.buckets.pragma.lines + census.buckets.license.lines + census.buckets.marker.lines,
    );
  });

  it("every scope's files add up to the census file count", () => {
    const census = loadCommentCensus(FIXTURE);
    const scoped = census.scopes.reduce((total, s) => total + s.files, 0);
    expect(scoped).toBe(census.totals.files);
  });
});

describe("comment census — deterministic output (SPEC §3)", () => {
  it("emits byte-identical JSON on two runs", () => {
    expect(renderComments(loadCommentCensus(FIXTURE), true, false)).toBe(
      renderComments(loadCommentCensus(FIXTURE), true, false),
    );
  });

  it("sorts files by comment lines descending, tiebroken on path", () => {
    const { files } = loadCommentCensus(FIXTURE);
    for (const [index, row] of files.slice(1).entries()) {
      const previous = files[index];
      if (previous === undefined) continue;
      expect(
        previous.commentLines > row.commentLines ||
          (previous.commentLines === row.commentLines && previous.file < row.file),
      ).toBe(true);
    }
  });

  it("renders a human view that leads with the census line", () => {
    expect(renderComments(loadCommentCensus(FIXTURE), false, false)).toMatch(
      /^comment census: [\d,]+ comment lines \/ [\d,]+ code lines \(\d+\.\d%\) over \d+ files\n/,
    );
  });
});
