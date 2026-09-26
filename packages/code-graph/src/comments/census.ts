import { isTestFile } from "../extract/functions.js";
import {
  type CommentSpan,
  collectModuleCommentRanges,
  commentLineNumbers,
  commentLineSpan,
  moduleLoc,
} from "../extract/metrics.js";
import { discoverPackageRoots, loadCheapProject } from "../extract/project.js";
import type { SyntaxFile } from "../syntax/file.js";
import {
  bucketRecord,
  bucketsIn,
  COMMENT_BUCKETS,
  type CommentBucket,
  classifyComment,
} from "./classify.js";

export type { CommentBucket } from "./classify.js";

export type CommentTally = { lines: number; count: number; files: number };

export type CommentFileRow = {
  file: string;
  loc: number;
  codeLines: number;
  blankLines: number;
  commentLines: number;
  mechanicalLines: number;
  protectedLines: number;
  proseLines: number;
  ratio: number;
  isTest: boolean;
  buckets: Record<CommentBucket, number>;
};

export type CommentScopeRow = {
  scope: string;
  files: number;
  loc: number;
  codeLines: number;
  commentLines: number;
  mechanicalLines: number;
  protectedLines: number;
  proseLines: number;
  ratio: number;
};

export type CommentCensus = {
  totals: {
    files: number;
    loc: number;
    codeLines: number;
    blankLines: number;
    commentLines: number;
    mechanicalLines: number;
    protectedLines: number;
    proseLines: number;
    ratio: number;
  };
  buckets: Record<CommentBucket, CommentTally>;
  scopes: CommentScopeRow[];
  files: CommentFileRow[];
};

function ratioOf(commentLines: number, codeLines: number): number {
  return Math.round((commentLines / Math.max(codeLines, 1)) * 1000) / 1000;
}

export function governedRatio(
  row: Pick<CommentScopeRow, "proseLines" | "mechanicalLines" | "codeLines">,
): number {
  return ratioOf(row.proseLines + row.mechanicalLines, row.codeLines);
}

function firstNonImportStart(syntax: SyntaxFile): number {
  for (const statement of syntax.program.body) {
    if (statement.type !== "ImportDeclaration") return syntax.tsStart(statement);
  }
  return Number.POSITIVE_INFINITY;
}

function tallyBuckets(
  sourceFile: SyntaxFile,
  ranges: readonly CommentSpan[],
): { lines: Record<CommentBucket, number>; counts: Record<CommentBucket, number> } {
  const lines = bucketRecord(() => 0);
  const counts = bucketRecord(() => 0);
  const headerCutoff = firstNonImportStart(sourceFile);
  const claimed = new Set<number>();
  let sawBlockComment = false;

  for (const range of ranges) {
    const text = range.text;
    const pos = range.pos;
    const isBlockComment = text.startsWith("/*");
    const fileHeaderCandidate = isBlockComment && !sawBlockComment && pos < headerCutoff;
    if (isBlockComment) sawBlockComment = true;

    const bucket = classifyComment({ text, pos, fileHeaderCandidate });
    counts[bucket] += 1;

    const { startLine, endLine } = commentLineSpan(sourceFile, range);
    for (let line = startLine; line <= endLine; line++) {
      if (claimed.has(line)) continue;
      claimed.add(line);
      lines[bucket] += 1;
    }
  }

  return { lines, counts };
}

function countBlankLines(sourceFile: SyntaxFile, loc: number, commentLines: Set<number>): number {
  const text = sourceFile.text.split("\n");
  let blank = 0;
  for (let line = 1; line <= loc; line++) {
    if (commentLines.has(line)) continue;
    if (/^\s*$/.test(text[line - 1] ?? "")) blank += 1;
  }
  return blank;
}

function classLines(lines: Record<CommentBucket, number>): {
  mechanicalLines: number;
  protectedLines: number;
  proseLines: number;
} {
  const sum = (commentClass: Parameters<typeof bucketsIn>[0]): number =>
    bucketsIn(commentClass).reduce((total, bucket) => total + lines[bucket], 0);
  return {
    mechanicalLines: sum("mechanical"),
    protectedLines: sum("protected"),
    proseLines: sum("prose"),
  };
}

function censusFile(
  sourceFile: SyntaxFile,
  file: string,
): { row: CommentFileRow; counts: Record<CommentBucket, number> } {
  const ranges = collectModuleCommentRanges(sourceFile);
  const commentLineSet = commentLineNumbers(sourceFile, ranges);
  const commentLines = commentLineSet.size;
  const loc = moduleLoc(sourceFile);
  const blankLines = countBlankLines(sourceFile, loc, commentLineSet);
  const codeLines = loc - commentLines - blankLines;
  const { lines, counts } = tallyBuckets(sourceFile, ranges);

  return {
    row: {
      file,
      loc,
      codeLines,
      blankLines,
      commentLines,
      ...classLines(lines),
      ratio: ratioOf(commentLines, codeLines),
      isTest: isTestFile(file),
      buckets: lines,
    },
    counts,
  };
}

function scopeOf(packageRoots: readonly string[], file: string): string {
  let best = "";
  for (const root of packageRoots) {
    if (root !== "" && root.length > best.length && file.startsWith(`${root}/`)) best = root;
  }
  return best === "" ? "." : best;
}

function scopeRows(
  rows: readonly CommentFileRow[],
  packageRoots: readonly string[],
): CommentScopeRow[] {
  const byScope = new Map<string, CommentScopeRow>();
  for (const row of rows) {
    const scope = scopeOf(packageRoots, row.file);
    const acc = byScope.get(scope) ?? {
      scope,
      files: 0,
      loc: 0,
      codeLines: 0,
      commentLines: 0,
      mechanicalLines: 0,
      protectedLines: 0,
      proseLines: 0,
      ratio: 0,
    };
    acc.files += 1;
    acc.loc += row.loc;
    acc.codeLines += row.codeLines;
    acc.commentLines += row.commentLines;
    acc.mechanicalLines += row.mechanicalLines;
    acc.protectedLines += row.protectedLines;
    acc.proseLines += row.proseLines;
    byScope.set(scope, acc);
  }
  const out = [...byScope.values()];
  for (const scope of out) scope.ratio = ratioOf(scope.commentLines, scope.codeLines);
  out.sort((a, b) => b.commentLines - a.commentLines || a.scope.localeCompare(b.scope));
  return out;
}

function summarize(
  rows: readonly CommentFileRow[],
  perFileCounts: readonly Record<CommentBucket, number>[],
): Pick<CommentCensus, "totals" | "buckets"> {
  const buckets = bucketRecord<CommentTally>(() => ({ lines: 0, count: 0, files: 0 }));
  const totals = {
    files: rows.length,
    loc: 0,
    codeLines: 0,
    blankLines: 0,
    commentLines: 0,
    mechanicalLines: 0,
    protectedLines: 0,
    proseLines: 0,
  };

  for (const [index, row] of rows.entries()) {
    totals.loc += row.loc;
    totals.codeLines += row.codeLines;
    totals.blankLines += row.blankLines;
    totals.commentLines += row.commentLines;
    totals.mechanicalLines += row.mechanicalLines;
    totals.protectedLines += row.protectedLines;
    totals.proseLines += row.proseLines;
    const counts = perFileCounts[index] ?? bucketRecord(() => 0);
    for (const bucket of COMMENT_BUCKETS) {
      const tally = buckets[bucket];
      tally.lines += row.buckets[bucket];
      tally.count += counts[bucket];
      if (counts[bucket] > 0) tally.files += 1;
    }
  }

  return {
    totals: { ...totals, ratio: ratioOf(totals.commentLines, totals.codeLines) },
    buckets,
  };
}

export function loadCommentCensus(rootAbsolute: string): CommentCensus {
  const { sourceFiles } = loadCheapProject(rootAbsolute);
  const packageRoots = discoverPackageRoots(rootAbsolute);

  const rows: CommentFileRow[] = [];
  const perFileCounts: Record<CommentBucket, number>[] = [];
  for (const unit of sourceFiles) {
    const { row, counts } = censusFile(unit.syntax, unit.file);
    rows.push(row);
    perFileCounts.push(counts);
  }

  const { totals, buckets } = summarize(rows, perFileCounts);
  const files = [...rows].sort(
    (a, b) => b.commentLines - a.commentLines || a.file.localeCompare(b.file),
  );
  return { totals, buckets, scopes: scopeRows(rows, packageRoots), files };
}
