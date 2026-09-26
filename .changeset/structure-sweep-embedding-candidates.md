---
"@demlik/structure-sweep": minor
---

Stage 6 can propose duplicate logic that does not look alike, through an embedding port the
consumer supplies (#395).

- **A provider-neutral port.** `EmbeddingPort` is `{ model, embed }`, where
  `embed(texts: string[]) => Promise<number[][]>`. structure-sweep bundles no provider and makes
  no network call of its own.
- **Lowered text, cached by content hash.** `embeddingStage` embeds each branch's lowered form from
  stage 2, never its source. It caches the vectors through the lowering artifact store, keyed on the
  lowered input and the model, so a repeat run calls `embed` for nothing.
- **A third candidate signal.** `clusterInput(resolved, data, { vectors, threshold })` pairs each
  branch with its nearest neighbour in another function. A pair at or above the threshold
  (`DEFAULT_SIMILARITY_THRESHOLD`, 0.9) becomes an `embedding`-basis candidate, and Jev confirms it
  through the existing confirm stage.
- **Nothing changes without a port.** Stage 6's input, key, clusters and ids stay the same.
- **Re-measure.** `remeasure` takes the same port as `after.embedding`.
