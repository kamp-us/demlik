import type { Tables } from "./tables.js";
import {
  compareNotFollowed,
  type NotFollowed,
  notFollowedLine,
  UNFOLLOWED_KINDS,
  type UnfollowedKind,
} from "./unfollowed.js";

// What the report says about the tables a run measured, beside its violations: how many files hold a
// write it could not follow, by kind (a kind with none is listed as zero), and which. B23 is silent
// about those writes, so a green gate says here how much of the repo it could not read. The view
// lists the same rows per scope under `Not followed`, from the same function.
export type TableCensus = {
  readonly notFollowed: Readonly<Record<UnfollowedKind, number>>;
  readonly rows: readonly NotFollowed[];
};

// The census of a run, or null when the rules file lists no table kind: then the report has nothing
// to say about tables, and says nothing.
export function tableCensus(tables: Tables, rows: readonly NotFollowed[]): TableCensus | null {
  if (tables.kinds.size === 0) return null;
  const counts = UNFOLLOWED_KINDS.map(
    (kind) => [kind, rows.filter((row) => row.kind === kind).length] as const,
  );
  return {
    notFollowed: Object.fromEntries(counts) as Record<UnfollowedKind, number>,
    rows: [...rows].sort(compareNotFollowed),
  };
}

export function tableCensusLines(census: TableCensus): string[] {
  const perKind = UNFOLLOWED_KINDS.map((kind) => `${kind} ${census.notFollowed[kind]}`).join(", ");
  return [
    `tables: ${census.rows.length} not followed (${perKind})`,
    ...census.rows.map((row) => `  ${notFollowedLine(row)}`),
  ];
}
