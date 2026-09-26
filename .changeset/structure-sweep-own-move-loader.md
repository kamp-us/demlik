---
"@demlik/structure-sweep": patch
---

The mover builds its own ts-morph program (#397). `@demlik/code-graph/project` no longer exports
`loadEdgeProject`, so `move` loads the scope's tsconfig plus every git-visible source file itself,
the same file set it read before. No flag or output changes.
