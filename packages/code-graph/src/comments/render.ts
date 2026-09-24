import { stableStringify } from "../render/json.js";
import type { CommentCensus, CommentFileRow, CommentScopeRow } from "./census.js";
import { bucketsIn, type CommentBucket, type CommentClass } from "./classify.js";

const HUMAN_FILE_LIMIT = 20;
const HUMAN_SCOPE_LIMIT = 20;

function n(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function bucketLine(census: CommentCensus, bucket: CommentBucket): string {
  const tally = census.buckets[bucket];
  return `  ${bucket.padEnd(20)}${n(tally.lines).padStart(8)}${n(tally.count).padStart(11)}${n(tally.files).padStart(8)}`;
}

function bucketGroup(census: CommentCensus, commentClass: CommentClass, heading: string): string[] {
  const byLines = (a: CommentBucket, b: CommentBucket): number =>
    census.buckets[b].lines - census.buckets[a].lines || a.localeCompare(b);
  return [heading, ...[...bucketsIn(commentClass)].sort(byLines).map((b) => bucketLine(census, b))];
}

function bucketTable(census: CommentCensus): string {
  return [
    `  ${"bucket".padEnd(20)}${"lines".padStart(8)}${"comments".padStart(11)}${"files".padStart(8)}`,
    ...bucketGroup(census, "mechanical", "  ---- mechanical (no judgment needed) ----"),
    ...bucketGroup(census, "prose", "  ---- prose (judgment required) ----"),
    ...bucketGroup(census, "protected", "  ---- protected (never touch) ----"),
  ].join("\n");
}

function scopeLine(scope: CommentScopeRow): string {
  return `  ${scope.scope.padEnd(38)}${n(scope.commentLines).padStart(9)}${n(scope.codeLines).padStart(9)}${pct(scope.ratio).padStart(8)}${n(scope.mechanicalLines).padStart(11)}`;
}

function scopeTable(census: CommentCensus): string {
  const head = `  ${"scope".padEnd(38)}${"comments".padStart(9)}${"code".padStart(9)}${"ratio".padStart(8)}${"mechanical".padStart(11)}`;
  const shown = census.scopes.slice(0, HUMAN_SCOPE_LIMIT).map(scopeLine);
  const rest = census.scopes.length - shown.length;
  const more = rest > 0 ? [`  … and ${n(rest)} more scope(s) (--json for all)`] : [];
  return [head, ...shown, ...more].join("\n");
}

function fileLine(row: CommentFileRow): string {
  return `  ${n(row.commentLines).padStart(8)}${pct(row.ratio).padStart(9)}${n(row.mechanicalLines).padStart(12)}  ${row.file}`;
}

function fileTable(census: CommentCensus): string {
  const shown = census.files.slice(0, HUMAN_FILE_LIMIT);
  if (shown.length === 0) return "no files in scope.";
  return [
    `top ${shown.length} files by comment lines (of ${n(census.files.length)})`,
    `  ${"comments".padStart(8)}${"ratio".padStart(9)}${"mechanical".padStart(12)}  file`,
    ...shown.map(fileLine),
  ].join("\n");
}

function renderHuman(census: CommentCensus): string {
  const { totals } = census;
  return [
    `comment census: ${n(totals.commentLines)} comment lines / ${n(totals.codeLines)} code lines (${pct(totals.ratio)}) over ${n(totals.files)} files`,
    `  ${n(totals.mechanicalLines)} mechanically cuttable · ${n(totals.protectedLines)} protected · ${n(totals.proseLines)} prose`,
    "",
    bucketTable(census),
    "",
    scopeTable(census),
    "",
    fileTable(census),
  ].join("\n");
}

export function renderComments(census: CommentCensus, json: boolean, pretty: boolean): string {
  if (json) return stableStringify(census, pretty);
  return renderHuman(census);
}
