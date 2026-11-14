import { globToRegExp } from "../../kinds/glob.js";
import { byText } from "../../order.js";
import { parseDocBlock } from "./block.js";
import { type ApiDocFinding, type BlockKind, findingsOf } from "./kinds.js";
import type { ApiDocsShape } from "./shape.js";

export type ApiDocFact = {
  readonly block: BlockKind;
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly reachedBy: readonly { readonly subpath: string; readonly name: string }[];
  readonly text: string | null;
};

export type JudgedDeclaration = Omit<ApiDocFact, "text"> & {
  readonly findings: readonly ApiDocFinding[];
};

export type ApiDocsReport = {
  readonly judged: number;
  readonly declarations: readonly JudgedDeclaration[];
};

function judgeDeclaration(fact: ApiDocFact, shape: ApiDocsShape): JudgedDeclaration {
  const { text, ...place } = fact;
  const rule = shape[fact.block];
  const findings =
    rule === undefined
      ? []
      : findingsOf({ block: text === null ? null : parseDocBlock(text), rule, order: shape.order });
  const reachedBy = [...place.reachedBy].sort(
    (a, b) => byText(a.subpath, b.subpath) || byText(a.name, b.name),
  );
  return { ...place, reachedBy, findings };
}

export function judgeApiDocs(facts: readonly ApiDocFact[], shape: ApiDocsShape): ApiDocsReport {
  const skip = shape.skip.map(globToRegExp);
  const judged = facts.filter(
    (fact) => shape[fact.block] !== undefined && !skip.some((glob) => glob.test(fact.file)),
  );
  judged.sort((a, b) => byText(a.file, b.file) || a.line - b.line || byText(a.name, b.name));
  const declarations = judged
    .map((fact) => judgeDeclaration(fact, shape))
    .filter((declaration) => declaration.findings.length > 0);
  return { judged: judged.length, declarations };
}
