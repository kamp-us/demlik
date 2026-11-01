---
"@demlik/structure-sweep": patch
---

`move apply` now reads backtick imports. A backtick path with no `${}` is rewritten like any other import and stays in backticks, in `import()`, `require()` and the `vi.*` calls. A backtick path with `${}` cannot be rewritten, so apply refuses before the rename commit, naming the row, importing file and specifier, when a row changes which file a run-time value loads. Moving such an import together with all it can load, keeping their layout, applies with it unchanged.
