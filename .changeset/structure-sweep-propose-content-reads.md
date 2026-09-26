---
"@demlik/structure-sweep": patch
---

`propose`'s content signals read exported names in any script whole (`ÖdemeServisi` → `ödeme`,
`servisi`), count `export … from` re-exports as import edges so a feature behind an `index.ts`
barrel stays one cluster, and read every file's content at `--ref` in one `git cat-file --batch`
subprocess instead of one `git show` per file.
