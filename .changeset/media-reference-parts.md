---
"@demlik/tea": minor
---

Image and file parts can name a host-owned blob with a `reference` source containing `key` and decoded `byteLength`. Tool results can persist that reference while the model adapter calls `resolveMediaParts` with its own blob reader. Compaction still counts the image and its decoded bytes without loading the blob. Resolution preserves part order and leaves stored content unchanged; read failures reach the model call's retry policy.
