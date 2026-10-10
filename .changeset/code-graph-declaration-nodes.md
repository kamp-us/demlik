---
"@demlik/code-graph": minor
---

Types, interfaces, enums, classes and constants now get nodes. The graph has a new `declarations`
list: one node per top-level declaration that is not already a function, with its name, kind,
file, line, exported flag and `uses`. With the edge pass, `uses` lists every `file` and `line` where
the type checker resolves a name to the declaration, through renamed imports and re-exports;
without it, `uses` is `null`.

The new `--find <name>` prints every function and declaration with that bare name as JSON, each
with its kind, file, line, exported flag and uses. A name with several matches is listed, not
refused. Function ids, metrics, smells, `calls` / `calledBy` and `--blast` are unchanged.
