---
"@demlik/structure-sweep": minor
---

`sweep` and `propose` now read imports, re-exports, exported names and module specifiers with
oxc-parser, in one shared module, instead of regexes (#441, #438, #439, #440). `oxc-parser` and
`oxc-resolver` are new runtime dependencies.

Sweep evidence that differs from before, each where the regex read the code wrong:

- A multi-line import whose bindings hold a comment with a quote (`// don't`) is now in `imports`,
  taken out of `source`, and credits the file it names in `importedBySiblings` (#441).
- Exported names in any script are read whole (`ÖdemeServisi`, `kullanıcıAdı`) (#438).
- `export * from`, `export * as ns from`, `export { a } from` and `export type { T } from` are in
  the barrel's `imports` and credit it as an importer of each file it re-exports (#439).
- `exports` also lists every declarator of one `export const a = 1, b = 2`, destructured exports,
  `export { a, b as c }` lists, `export var`, `export abstract class`, `export declare …` and
  `export namespace`.
- An `import` line inside a template literal or comment is no longer read as an import, nor taken
  out of `source`.

`propose`'s content signals change where the same reads apply: the wider `exports` add terms, a
bare `import "./x"` is an import edge, and an import-shaped line in a string or comment is not.

`sweep` reads every file at `--ref` in one `git cat-file --batch` instead of one `git show` per file.

`sweep --redact` now hides every specifier that names code in the repository, not only relative
ones. A tsconfig `paths` alias (read from the tsconfig code-graph picks for the scope) that resolves
to a swept file gets the same `./f<n>` id a relative specifier naming that file gets. A specifier
that resolves nowhere gets an id too. Only a specifier that resolves into `node_modules`, or a Node
builtin, stays as written. A file that does not parse has its source withheld under `--redact`.
Specifier sites are now the parser's, so a specifier-shaped string in a comment is no longer
rewritten under `--redact`.

Verdict rows carry an `extractor` field, and it is part of the cache key: every sweep verdict
cached before this release is recomputed once.
