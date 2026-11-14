import { stableStringify } from "../../render/json.js";
import type { ApiDocGap } from "./gaps.js";
import type { ApiDocsReport, JudgedDeclaration } from "./judge.js";
import { BLOCK_KINDS, findingWords } from "./kinds.js";

export function declarationFindingLines({
  block,
  file,
  line,
  name,
  findings,
}: JudgedDeclaration): string[] {
  return findings.map((finding) => `${file}:${line}  ${name}  ${findingWords(finding, block)}`);
}

export function renderApiDocs(report: ApiDocsReport): string {
  const lines = report.declarations.flatMap(declarationFindingLines);
  const nouns = BLOCK_KINDS.export;
  const noun = report.judged === 1 ? nouns.singular : nouns.plural;
  lines.push(
    `api docs: ${report.judged} ${noun} judged, ${report.declarations.length} with a finding`,
  );
  return `${lines.join("\n")}\n`;
}

export function apiDocsJson(
  report: ApiDocsReport,
  gaps: readonly ApiDocGap[],
  pretty: boolean,
): string {
  return `${stableStringify({ ...report, gaps }, pretty)}\n`;
}
