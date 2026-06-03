import { diffState, formatDiff, type StateChange } from "./state-diff";

export interface StateDiffProps {
  /**
   * The baseline / "before" state — what you expected. In a regression view
   * this is a trace's recorded `finalState`; in a time-travel view it's the
   * previous model.
   */
  expected: unknown;
  /**
   * The "after" state to compare against `expected` — the recomputed or
   * current model.
   */
  actual: unknown;
  /** Optional className appended to the container. Use to override layout. */
  className?: string;
}

/** Per-kind row glyph + value rendering. Lives here (not CSS ::before like the
 * MsgLog rows) because the diff prints the path AND the value(s), so the glyph
 * is part of structured content the screen reader should read in order. */
function changeRow(c: StateChange) {
  // `path` is unique within one diff (each cell appears at most once), so it is
  // a stable React key without needing the array index.
  switch (c.kind) {
    case "changed":
      return (
        <div key={c.path} className="tea-dt-diff-row tea-dt-diff-changed">
          <span className="tea-dt-diff-mark">~</span>
          <span className="tea-dt-diff-path">{c.path}</span>
          <span className="tea-dt-diff-old">{fmt(c.expected)}</span>
          <span className="tea-dt-diff-arrow">→</span>
          <span className="tea-dt-diff-new">{fmt(c.actual)}</span>
        </div>
      );
    case "removed":
      return (
        <div key={c.path} className="tea-dt-diff-row tea-dt-diff-removed">
          <span className="tea-dt-diff-mark">-</span>
          <span className="tea-dt-diff-path">{c.path}</span>
          <span className="tea-dt-diff-old">{fmt(c.expected)}</span>
        </div>
      );
    case "added":
      return (
        <div key={c.path} className="tea-dt-diff-row tea-dt-diff-added">
          <span className="tea-dt-diff-mark">+</span>
          <span className="tea-dt-diff-path">{c.path}</span>
          <span className="tea-dt-diff-new">{fmt(c.actual)}</span>
        </div>
      );
  }
}

/** Compact value render for a row cell. Strings get quotes; objects/arrays a
 * JSON-ish one-liner — the diff already names the leaf path, so a deep render
 * isn't needed here. */
function fmt(v: unknown): string {
  if (v === undefined) return "undefined";
  if (typeof v === "number" && Number.isNaN(v)) return "NaN";
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "function" || typeof v === "symbol") return String(v);
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * Presentational diff of two states. Renders {@link diffState}'s output as a
 * color-coded list (added / removed / changed), reusing the devtools `tea-dt-*`
 * class convention so it inherits the same design tokens as `<StateInspector>`
 * and `<MsgLog>` (see ./styles.css). No state, no subscription — pass the two
 * states as props, exactly like the rest of /devtools.
 *
 * When the states are deeply equal the list is empty; a tiny "no changes" hint
 * renders so an operator can tell "equal" from "not yet computed".
 */
export function StateDiff({ expected, actual, className }: StateDiffProps) {
  const changes = diffState(expected, actual);
  return (
    <div
      className={`tea-dt-diff${className ? ` ${className}` : ""}`}
      // The plain-text diff is the accessible/copyable fallback for the
      // color-coded rows — same content `formatDiff` produces in Node/tests.
      title={changes.length === 0 ? "no changes" : formatDiff(changes)}
    >
      {changes.length === 0 ? (
        <div className="tea-dt-diff-empty">no changes</div>
      ) : (
        changes.map(changeRow)
      )}
    </div>
  );
}
