---
"@demlik/code-graph": minor
---

`code-graph --boundaries` can license some names of a library to one importer. A rules file's new
`allowImportNames` key (`{ "<importer>": { "<imported library>": ["<name>", …] } }`, both directories
as `libraries` writes them, named as ESLint's `no-restricted-imports` option is) waives B12
`library-imports-up` for a file when the allowance lists every name it imports from that library, so a
repo whose client apps import a service's contract library directly can record today's imports with
`--accept-crossings`, keep the names a client legitimately produces out of the ledger, and watch the
ledger shrink as clients move to the generated types.

  - A name is the exported name, summed over all of a file's imports of the library: `import { A as B }`
    and `export { A } from` take `A`, a subpath and a type-only import count. A default import,
    `import * as ns`, `export * from`, `import()` and `import "m"` take no readable name and stay B12
    whatever the list says. The entry is unchanged: one per importing file and library.
  - Exit 2 with nothing written, in one line naming `allowImportNames`, for an importer or an imported
    library that is no declared library, an importer whose type already lists the imported library's
    type, and a name the importer never imports from that library.
  - A rules file without the key runs as before. There is no new kind, and `--graph`, the ledger and
    `ImportEdgeSchema` are unchanged.

A port-layout scope now lists all three of `application`, `driving-adapters` and `driven-adapters`. A
scope that lists some of them, or lists none while its `src/` holds one, exits 2 with one line naming
the scope and the folders it leaves out and writes nothing, where it used to leave those folders'
files unjudged and unreported. The port layout's zone table no longer carries an `index` or an
`unknown` row, and a port scope can no longer produce an `unknown-zone` entry.
