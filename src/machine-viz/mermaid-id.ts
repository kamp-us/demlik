// ═══════════════════════════════════════════════════════════════════════════
// MERMAID SANITIZING — the two functions every drawing in this package shares.
//
// Mermaid state ids must be identifier-safe, and a transition label must not
// contain the characters that terminate it. Both `machine-viz`'s `toMermaid`
// (which draws a COMPILED machine) and `chart`'s `chartMermaid` (which draws
// the CHART) need exactly this, and a state name like `human:cp-approval` —
// real, from `src/chart/__fixtures__/lane.ts` — breaks the diagram in both.
//
// So it lives here, in a module with NO imports: `machine-viz/index.ts` pulls
// in the whole substrate (`formOf` from `../index`), and `chart/compile.ts`
// must not acquire that dependency merely to sanitize a string.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Sanitize a discriminant string into a Mermaid-safe node identifier.
 *
 * Any run of non-identifier characters becomes `_`; a leading digit is
 * prefixed so the id is always a valid Mermaid token; the empty string gets a
 * stable placeholder. Deterministic and idempotent — `safeId(safeId(x))` is
 * `safeId(x)`, so a diagram may sanitize the same name at several sites.
 */
export function safeId(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "_");
  if (cleaned === "") return "_empty";
  return /^[0-9]/.test(cleaned) ? `s_${cleaned}` : cleaned;
}

/**
 * Sanitize text used as a Mermaid edge/transition label (the part after `:`).
 *
 * Strips the characters that terminate or confuse a label: newlines, the `:`
 * that separates label from target, and Mermaid's `"`/`;` delimiters.
 */
export function safeLabel(raw: string): string {
  return raw.replace(/["\n\r;:]/g, " ").trim();
}
