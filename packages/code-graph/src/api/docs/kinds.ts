import type { DocBlock } from "./block.js";
import type { DocRule } from "./shape.js";

export const BLOCK_KINDS = {
  export: { noBlock: "no doc block", singular: "export", plural: "exports" },
} satisfies Record<string, { noBlock: string; singular: string; plural: string }>;

export type BlockKind = keyof typeof BLOCK_KINDS;

export type ApiDocFinding =
  | { readonly kind: "missing-block" }
  | { readonly kind: "missing-description" }
  | { readonly kind: "missing-tag"; readonly tag: string }
  | { readonly kind: "forbidden-tag"; readonly tag: string }
  | { readonly kind: "tag-out-of-order"; readonly tag: string; readonly before: string };

type CheckInput = {
  readonly block: DocBlock | null;
  readonly rule: DocRule;
  readonly order: readonly string[];
};

type FindingRows = {
  [Kind in ApiDocFinding["kind"]]: {
    readonly check: (input: CheckInput) => readonly Extract<ApiDocFinding, { kind: Kind }>[];
    readonly words: (finding: Extract<ApiDocFinding, { kind: Kind }>, block: BlockKind) => string;
  };
};

// Row order is the print order (SPEC §13.10).
const FINDING_KINDS: FindingRows = {
  "missing-block": {
    check: ({ block, rule }) =>
      block === null && rule.block === "required" ? [{ kind: "missing-block" }] : [],
    words: (_finding, block) => BLOCK_KINDS[block].noBlock,
  },
  "missing-description": {
    check: ({ block, rule }) =>
      block !== null && rule.description === "required" && block.description === ""
        ? [{ kind: "missing-description" }]
        : [],
    words: () => "the description is empty",
  },
  "missing-tag": {
    check: ({ block, rule }) =>
      block === null
        ? []
        : rule.required
            .filter((tag) => !block.tags.includes(tag))
            .map((tag) => ({ kind: "missing-tag", tag })),
    words: ({ tag }) => `missing ${tag}`,
  },
  "forbidden-tag": {
    check: ({ block, rule }) =>
      block === null
        ? []
        : rule.forbidden
            .filter((tag) => block.tags.includes(tag))
            .map((tag) => ({ kind: "forbidden-tag", tag })),
    words: ({ tag }) => `${tag} is forbidden`,
  },
  "tag-out-of-order": {
    check: ({ block, order }) => {
      const findings: Extract<ApiDocFinding, { kind: "tag-out-of-order" }>[] = [];
      let latest = -1;
      for (const before of block?.tags ?? []) {
        const position = order.indexOf(before);
        if (position < 0) continue;
        const tag = order[latest];
        if (position < latest && tag !== undefined) {
          findings.push({ kind: "tag-out-of-order", tag, before });
        } else {
          latest = position;
        }
      }
      return findings;
    },
    words: ({ tag, before }) => `${tag} comes before ${before}`,
  },
};

export function findingsOf(input: CheckInput): readonly ApiDocFinding[] {
  return Object.values(FINDING_KINDS).flatMap((row): readonly ApiDocFinding[] => row.check(input));
}

export function findingWords(finding: ApiDocFinding, block: BlockKind): string {
  const words = FINDING_KINDS[finding.kind].words as (
    finding: ApiDocFinding,
    block: BlockKind,
  ) => string;
  return words(finding, block);
}
