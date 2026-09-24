import { hasDirection, ratchetTableLines, type ScopeCountVerdict } from "../ratchet/scope-count.js";
import { stableStringify } from "../render/json.js";

export const CEILINGS_FILENAME = "collapse-ceilings.json";

function failureLines(verdict: ScopeCountVerdict): string[] {
  const lines = ratchetTableLines(verdict, "PARTIAL-TWIN");
  if (hasDirection(verdict, "EXCEEDED")) {
    lines.push(
      "  EXCEEDED: a new shared decision prologue diverges on the same named constants.",
      "  Collapse it, or say in the PR body why the divergence is intended and re-record.",
      "  `pnpm code-graph <scope> --collapse` shows the pairs.",
    );
  }
  if (hasDirection(verdict, "SLACK")) {
    lines.push(
      "  SLACK: the ceiling sits above reality, so it is no longer a ceiling. Re-record:",
      "  `pnpm code-graph <scope> --collapse --write-ceilings`.",
    );
  }
  return lines;
}

export type RatchetRender = { readonly stdout: string; readonly exitCode: number };

export function renderPartialTwinRatchet(
  verdict: ScopeCountVerdict,
  json: boolean,
  pretty: boolean,
): RatchetRender {
  const exitCode = verdict.passed ? 0 : 1;
  if (json) return { stdout: stableStringify(verdict, pretty), exitCode };
  if (verdict.passed) {
    return {
      stdout: `partial-twin ratchet: PASS — ${verdict.scopesChecked} scope(s) on their ceiling.`,
      exitCode,
    };
  }
  return { stdout: failureLines(verdict).join("\n"), exitCode };
}
