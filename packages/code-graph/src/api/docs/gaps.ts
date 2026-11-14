import { byText } from "../../order.js";

export type ApiDocGap =
  | { readonly kind: "unresolved-specifier"; readonly file: string; readonly specifier: string }
  | { readonly kind: "syntax-error"; readonly file: string; readonly count: number }
  | { readonly kind: "no-declaration"; readonly subpath: string; readonly name: string };

type GapRow<Gap extends ApiDocGap> = {
  readonly words: (gap: Gap) => string;
  readonly keys: (gap: Gap) => readonly string[];
};

const GAP_KINDS: {
  [Kind in ApiDocGap["kind"]]: GapRow<Extract<ApiDocGap, { kind: Kind }>>;
} = {
  "unresolved-specifier": {
    words: ({ file, specifier }) =>
      `${file} names "${specifier}", which the read could not resolve; a name behind it is not judged`,
    keys: ({ file, specifier }) => [file, specifier],
  },
  "syntax-error": {
    words: ({ file, count }) =>
      `${file} has ${count} syntax error(s); a declaration in it may not be judged`,
    keys: ({ file }) => [file],
  },
  "no-declaration": {
    words: ({ subpath, name }) =>
      `${subpath} publishes "${name}", which the read found no declaration for; it is not judged`,
    keys: ({ subpath, name }) => [subpath, name],
  },
};

const rowOf = (gap: ApiDocGap): GapRow<ApiDocGap> => GAP_KINDS[gap.kind] as GapRow<ApiDocGap>;

export function orderApiDocGaps(gaps: readonly ApiDocGap[]): readonly ApiDocGap[] {
  const kinds = Object.keys(GAP_KINDS);
  return [...gaps].sort((a, b) => {
    const kind = kinds.indexOf(a.kind) - kinds.indexOf(b.kind);
    if (kind !== 0) return kind;
    const left = rowOf(a).keys(a);
    const right = rowOf(b).keys(b);
    for (const [index, value] of left.entries()) {
      const compared = byText(value, right[index] ?? "");
      if (compared !== 0) return compared;
    }
    return 0;
  });
}

export function apiDocGapLine(gap: ApiDocGap): string {
  return `code-graph: warning: ${rowOf(gap).words(gap)}`;
}
