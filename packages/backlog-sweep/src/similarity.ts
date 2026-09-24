const STOPWORDS = new Set(
  "a an and are as at be by do does for from has have in into is it its not of on or so that the this to was we when with without which who why how what can should must one no only than then there these they via".split(
    " ",
  ),
);

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter(
    (t) => !STOPWORDS.has(t),
  );
}

export interface Doc {
  readonly id: number;
  readonly text: string;
}

type Vector = ReadonlyMap<string, number>;

export class TfIdf {
  private readonly idf: Map<string, number>;
  private readonly vectors: Map<number, Vector>;

  constructor(docs: readonly Doc[]) {
    const df = new Map<string, number>();
    const counts = docs.map((doc) => {
      const tf = new Map<string, number>();
      for (const t of tokens(doc.text)) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      return [doc.id, tf] as const;
    });
    this.idf = new Map(
      [...df].map(([t, n]) => [t, Math.log((1 + docs.length) / (1 + n)) + 1]),
    );
    this.vectors = new Map(counts.map(([id, tf]) => [id, this.weigh(tf)]));
  }

  private weigh(tf: ReadonlyMap<string, number>): Vector {
    const weighted = new Map<string, number>();
    let norm = 0;
    for (const [t, n] of tf) {
      const w = (1 + Math.log(n)) * (this.idf.get(t) ?? 0);
      weighted.set(t, w);
      norm += w * w;
    }
    const length = Math.sqrt(norm) || 1;
    for (const [t, w] of weighted) weighted.set(t, w / length);
    return weighted;
  }

  nearest(id: number, k: number): { id: number; score: number }[] {
    const query = this.vectors.get(id);
    if (query === undefined) return [];
    const scored: { id: number; score: number }[] = [];
    for (const [other, vector] of this.vectors) {
      if (other === id) continue;
      let dot = 0;
      for (const [t, w] of query) dot += w * (vector.get(t) ?? 0);
      if (dot > 0) scored.push({ id: other, score: dot });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, k);
  }
}
