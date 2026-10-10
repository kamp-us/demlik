---
"@demlik/code-graph": minor
---

`InProcessGraph` (`@demlik/code-graph/resolve`) can now ask a module file directly what it exports.
`resolveModuleExport(moduleFile, exportName)` follows re-exports and aliases from the module itself
and returns an `ExportDeclaration`: the declaring file, the declared name, and the 1-based line of
the declaration's first token. An entry file that only re-exports no longer needs a probe file that
imports it, and the line tells two declarations of one name in one file apart.
`resolvePublishingSubpaths(entries, exportName)` takes your own subpath-to-source map and returns
each subpath that publishes the name, with its declaration. It never guesses how build output maps
back to source. `resolveExportOrigin` and `ExportOrigin` are unchanged.
