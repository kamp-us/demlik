export type ApiDocGap =
  | { readonly kind: "unresolved-specifier"; readonly file: string; readonly specifier: string }
  | { readonly kind: "syntax-error"; readonly file: string; readonly count: number }
  | { readonly kind: "no-declaration"; readonly subpath: string; readonly name: string };

type GapFields = {
  readonly kind: ApiDocGap["kind"];
  readonly file?: string;
  readonly specifier?: string;
  readonly count?: number;
  readonly subpath?: string;
  readonly name?: string;
};

const GAP_KINDS = {
  "unresolved-specifier": {
    words: ({ file, specifier }: GapFields) =>
      `${file} names "${specifier}", which the read could not resolve; a name behind it is not judged`,
    keys: ["file", "specifier"],
  },
  "syntax-error": {
    words: ({ file, count }: GapFields) =>
      `${file} has ${count} syntax error(s); a declaration in it may not be judged`,
    keys: ["file"],
  },
  "no-declaration": {
    words: ({ subpath, name }: GapFields) =>
      `${subpath} publishes "${name}", which the read found no declaration for; it is not judged`,
    keys: ["subpath", "name"],
  },
} satisfies Record<
  ApiDocGap["kind"],
  { words: (gap: GapFields) => string; keys: readonly (keyof GapFields)[] }
>;

export function orderApiDocGaps(gaps: readonly ApiDocGap[]): readonly ApiDocGap[] {
  const kinds = Object.keys(GAP_KINDS);
  return [...gaps].sort((a, b) => {
    const kind = kinds.indexOf(a.kind) - kinds.indexOf(b.kind);
    if (kind !== 0) return kind;
    const left: GapFields = a;
    const right: GapFields = b;
    for (const key of GAP_KINDS[a.kind].keys) {
      const x = left[key] ?? "";
      const y = right[key] ?? "";
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  });
}

export function apiDocGapLine(gap: ApiDocGap): string {
  return `code-graph: warning: ${GAP_KINDS[gap.kind].words(gap)}`;
}
