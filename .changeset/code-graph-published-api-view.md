---
"@demlik/code-graph": minor
---

New opt-in mode: the published-API view. `code-graph <package> --api <map>` and
`readPublishedApi(root, map)` from the new `@demlik/code-graph/api` subpath list, per export
subpath, every name the package publishes with its declaration text as a consumer's types see it.
You write the map (`{ "<subpath>": { "entry": "<source file>", "tier"?: "<string>" } }`); code-graph
reads no export map or build config. It emits the package's declarations with the pinned tsgo into
a temp folder outside the checkout, so an inferred return type shows in a name's text, and each name
carries the text of the unpublished declarations it references, so a change to a private type shows
on the published name that uses it. The output is sorted JSON, the same bytes for the same commit.
Without `--api`, every other output is unchanged. `@demlik/code-graph/resolve` also exports
`moduleSymbolOf`, the file-to-module-symbol step the view shares with `resolveModuleExport`.
