---
"@demlik/code-graph": minor
---

code-graph reads TypeScript with oxc and tsgo instead of ts-morph (#397).

Every syntax pass (function discovery, metrics, comments, env keys, layers, the module and import
graph) parses with `oxc-parser` and resolves specifiers with `oxc-resolver`; `--boundaries` now
builds its import edges from those alone and no longer pays for call resolution. Callee and caller
resolution, node kinds, references, cross-runtime method resolution and `loadInProcessGraph` run on
tsgo's checker. CLI flags, JSON output and config keys are unchanged, and the output matches the
ts-morph engine's on the parity fixture byte for byte.

**New runtime dependencies:** `oxc-parser`, `oxc-resolver` and `@typescript/native-preview` (the
tsgo API, `unstable/*`, pinned to one exact dev build). `ts-morph` is no longer a dependency.

**Breaking, `@demlik/code-graph/project`:** `loadEdgeProject`, `loadCheapProject` and the
ts-morph-typed `LoadedProject` / `LoadedEdgeProject` are removed, since they returned ts-morph's
`Project`. The subpath keeps `listVisibleFiles`, `listSourceFiles`, `discoverPackageRoots`,
`resolveEdgeTsConfig`, `toRelative`, `findRepoRoot` and the `EdgeScope` type. Build a ts-morph
program yourself from `resolveEdgeTsConfig` and `listSourceFiles` if you need one.
