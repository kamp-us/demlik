import type { DocBlock } from "./block.js";
import type { DocRule } from "./shape.js";

export const BLOCK_KINDS = {
  export: { noBlock: "no doc block", singular: "export", plural: "exports" },
} satisfies Record<string, { noBlock: string; singular: string; plural: string }>;

export type BlockKind = keyof typeof BLOCK_KINDS;

export type DocFinding =
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

type WordsInput = {
  readonly kind: DocFinding["kind"];
  readonly tag?: string;
  readonly before?: string;
};

type FindingRows = {
  [Kind in DocFinding["kind"]]: {
    readonly check: (input: CheckInput) => readonly Extract<DocFinding, { kind: Kind }>[];
    readonly words: (finding: WordsInput, block: BlockKind) => string;
  };
};

export const FINDING_KINDS = {
  "missing-block": {
    check: ({ block, rule }) =>
      block === null && rule.block === "required" ? [{ kind: "missing-block" }] : [],
    words: (_finding: WordsInput, block: BlockKind) => BLOCK_KINDS[block].noBlock,
  },
  "missing-description": {
    check: ({ block, rule }) =>
      block !== null && rule.description === "required" && block.description === ""
        ? [{ kind: "missing-description" }]
        : [],
    words: (_finding: WordsInput) => "the description is empty",
  },
  "missing-tag": {
    check: ({ block, rule }) =>
      block === null
        ? []
        : rule.required
            .filter((tag) => !block.tags.includes(tag))
            .map((tag) => ({ kind: "missing-tag", tag })),
    words: ({ tag }: WordsInput) => `missing ${tag}`,
  },
  "forbidden-tag": {
    check: ({ block, rule }) =>
      block === null
        ? []
        : rule.forbidden
            .filter((tag) => block.tags.includes(tag))
            .map((tag) => ({ kind: "forbidden-tag", tag })),
    words: ({ tag }: WordsInput) => `${tag} is forbidden`,
  },
  "tag-out-of-order": {
    check: ({ block, order }) => {
      const findings: Extract<DocFinding, { kind: "tag-out-of-order" }>[] = [];
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
    words: ({ tag, before }: WordsInput) => `${tag} comes before ${before}`,
  },
} satisfies FindingRows;
