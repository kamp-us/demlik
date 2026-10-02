# @demlik/code-graph

## 0.6.0

### Minor Changes

- 21298eb: `--boundaries` now judges the shape of a hexagonal feature's own files, beside the feature level
  (B1-B10), the library level (B11-B14) and the deployable level (B17-B19). Two new kinds fail the
  merge gate by name, each a `boundary-ledger.json` entry recorded with `--accept-crossings --reason`
  and pruned as it is fixed, and four more `--boundary-rules` keys change what the existing rules
  judge. Six new keys in all:

  - `applicationShape`: the kinds that run, none by default.
  - **B15 `index-not-exports-only`**: the entry file of a declared library (`src/index.ts`) or of a
    hexagonal feature (`src/<feature>/index.ts`) that holds anything but named re-exports. One entry
    per file; the specifier is the first offending form in source order (`export *`,
    `export default`, `local export`, `import`, `declaration` or `statement`) and the whole identity.
  - **B16 `application-import-outside-allowlist`**: an `application/` import of anything but its own
    `ports.ts` and `application/`, another feature's `index.ts`, a `lib` folder, a library whose type
    `applicationMayImport` lists, or a package `pureDependencies` matches. Type-only imports are
    judged. An import another kind judges (B1, B6, B7, B14) is that kind's alone.
  - `applicationMayImport` and `pureDependencies`: what B16 allows beyond the zones. They need B16
    listed, and there is no built-in type name.
  - `testFiles`: globs of the files that are tests. A matched file sits in no zone, and one table (a
    row per kind) says which kinds still judge it: B1-B5, B12, B14 and B19 do; B6-B10, B13, B15, B16
    and B17 do not. A test beside a feature's `index.ts` is no B10 entry.
  - `strictDriving`: scopes where B9 judges every catalog door in `index.ts`, `ports.ts` and
    `adapters/driving/`, declared or not.
  - `readAllowance`: per scope, the driven files a driving adapter may import when it also imports a
    library of a `decidedBy` type when it runs. A listed file that writes through a data binding (the
    access `--data` computes) is never licensed, and the report names the write; the ledger entry
    keeps the shape and key of any B8.

  **B15 and B16 are off until `applicationShape` lists them**, so a minor release never fails the gate
  of a repo that did not ask for them. A repo that declares none of the six keys is unchanged: its
  report, ledger entries and `--json` are exactly what they were, no wrangler config is read and no
  further repo listing is made. A bad declaration (a kind outside the two, a key that needs B16 while
  it is off, a type `libraryTypes` lacks, an invalid glob, a scope that is not hexagonal, a driven file
  that is not under `adapters/driven/` or that the scope does not load) exits 2 and writes nothing, and
  so does a wrangler config it cannot parse while `readAllowance` is declared. `--migrate-ceilings`
  seeds the two kinds without counting them against a ceiling.

  The `@demlik/code-graph/boundaries` subpath accepts the two new kinds in a ledger, so its published
  schema widens. An older release refuses a ledger that holds them, so upgrade the tool before
  committing one.

## 0.5.0

### Minor Changes

- 143392a: `--boundaries` now judges across deployables, beside the feature level (B1-B10) and the library
  level (B11-B14). A repo of several workers and shared packages turns on three new kinds by naming
  them in a new `--boundary-rules` key, `acrossDeployables`, and each fails the merge gate by name as a
  `boundary-ledger.json` entry, recorded with `--accept-crossings --reason` and pruned as it is fixed:

  - **B17 `binding-outside-driven-adapter`**: a worker binding (a service binding, or a D1, Durable
    Object, KV, R2 or queue binding) its owning worker's deploy config declares, used in a file that is
    not under a hexagonal feature's `adapters/driven/`. One entry per file per binding. It reuses the
    syntax-only call-site finder `--data` runs (`env.X`, `this.env.X`, `c.env.X`, one level of aliasing,
    a destructure off `env`), so it runs on the cheap pass and starts no type checker. An optional
    second key, `bindingOwners`, narrows a binding to exact driven-adapter files, as `doors` does.
  - **B18 `worker-call-cycle`**: two or more workers that bind each other in a loop, one entry per
    strongly connected component of the service-binding graph the wrangler configs declare. Its scope
    is `.`, and only a run at the repo root measures it.
  - **B19 `relative-import-crosses-workspace`**: a relative import whose target sits in another
    workspace than the importer, judged by nearest `package.json`. One entry per importer and other
    workspace; a path alias and a bare specifier are not judged.

  **The three kinds are off until listed**, so a minor release never fails the gate of a repo that did
  not ask for them. A rules file that lists none is unchanged: its report, ledger entries and `--json`
  are exactly what they were, no wrangler config is read, and no further repo listing is made. With a
  kind listed, `--boundaries` ends its report with a census of the worker bindings it read (`deployables`
  in `--json`). `--migrate-ceilings` seeds the three kinds without counting them against a ceiling. A
  bad declaration (a kind outside the three, or a `bindingOwners` that cannot be honoured) exits 2 and
  writes nothing, and so does a wrangler config it cannot parse while B17 or B18 is listed, so a worker
  is never dropped from the judgment silently.

  The `@demlik/code-graph/boundaries` subpath accepts the three new kinds in a ledger, so its
  published schema widens. An older release refuses a ledger that holds them, so upgrade the tool
  before committing one.

## 0.4.0

### Minor Changes

- 006b1a3: `--boundaries` now judges the package level beside the feature level. A repo whose packages are
  libraries of declared types (contract, kernel, util, adapter, ui) declares them in the
  `--boundary-rules` file with four new keys, and four new kinds fail the merge gate by name, each a
  `boundary-ledger.json` entry recorded with `--accept-crossings --reason` and pruned as it is fixed:

  - `libraryTypes`: each type, the types it may import (a table, not `--layers`' total order), whether
    it is `pure`, and optionally where a library of it may be imported from (`importedFrom`:
    `driven`, `configurator` or `any`). The type names are the rules file's, not the tool's.
  - `libraries`: a package's directory, to its type. Each is a scope named by its directory.
  - `libraryRoots`: directories whose packages must each be declared.
  - `worldLibraries`: package globs a pure library may not import (`@sentry/*` matches `@sentry/node`
    and its subpaths).

  - **B11 `library-undeclared`**: a package under a library root that `libraries` does not name.
  - **B12 `library-imports-up`**: an import to a library whose type the importer's type does not
    list, resolved by package name, subpaths included. Type-only imports are judged.
  - **B13 `impure-library`**: in a pure library, any world door used by name or opened as a module,
    and any import of a world library. A call on an injected object is not seen.
  - **B14 `adapter-library-imported-outside-driven`**: an import of a library from outside the zones
    its type's `importedFrom` names.

  `--boundaries` ends its report with a census of the libraries, the undeclared packages and the
  imports left unjudged. `--migrate-ceilings` seeds the four kinds without counting them against a
  ceiling. A bad declaration, and the key `pureDependencies`, exit 2 and write nothing.

  `discoverPackageRoots` and `listVisibleFiles` of `@demlik/code-graph/project` take an optional
  trailing `listing` (a repo's files listed once, which a run over many scopes shares); called without
  it they behave as before.

  A rules file that declares none of the four keys is unchanged: its report, its ledger entries and a
  ledger written before this release read and gate exactly as they did. An older release refuses a
  ledger that holds the new kinds, so upgrade the tool before committing one.

## 0.3.0

### Minor Changes

- a7d1f46: `--boundaries` now understands a second feature layout, Alistair Cockburn's hexagonal zones, one
  scope at a time. A `layout` key in the `--boundary-rules` file opts a scope in:
  `"layout": { "services/api": "hexagonal" }`. That scope's features are laid out as `index.ts`,
  `ports.ts`, `application/`, `adapters/driving/` and `adapters/driven/`, and five new kinds judge
  inside them, each a `boundary-ledger.json` entry recorded with `--accept-crossings --reason` and
  pruned as it is fixed:

  - **B6 `application-imports-adapter`**: `application/` importing its own feature's `adapters/`.
  - **B7 `impure-application`**: any world door used by name or module door opened in
    `application/`, declared or not.
  - **B8 `driving-reaches-driven`**: `adapters/driving/` importing its own `application/` or
    `adapters/driven/` instead of going through `ports.ts` and `index.ts`.
  - **B9 `door-outside-driven-adapter`**: a declared door used in `index.ts`, `ports.ts` or
    `adapters/driving/`.
  - **B10 `unknown-zone`**: a feature entry outside those zones (`domain/`, `helpers.ts`,
    `adapters/shared/`), once per entry.

  A file outside every feature may import any feature's adapters (the composition root). A `layout`
  for a scope with no `features`, a value other than `rules` or `hexagonal`, and a door owner in a
  hexagonal `index.ts`, `ports.ts`, `application/` or `adapters/driving/` exit 2 and write nothing.

  A scope without `layout` keeps the `rules/` layout and is unchanged: its report, its ledger entries
  and a ledger written before this release read and gate exactly as they did.

- 35c7028: `--boundaries` now holds every `process` member to the purity of `rules/`, and stops counting a
  type-only import as a door use.

  - **Every `process.<member>` is a B2 door in `rules/`.** The catalog's seven `process` rows become
    one family row, and each member is its own door. A rules file that calls `process.hrtime()`, reads
    `process.platform` or `process.versions`, or calls `process.on(...)` passed as pure before and is
    now an `impure-rules` entry named for the member (`process.hrtime`), one per file per member:
    `process.hrtime()` beside `process.hrtime.bigint()` is one entry. The seven names the catalog
    listed before (`env`, `argv`, `stdin`, `stdout`, `stderr`, `exit`, `cwd`) keep their spelling, so a
    `boundary-ledger.json` written by the previous release gates unchanged for them. A repo's first
    `--ci` after upgrading lists the current uses of every member beyond those seven until
    `--accept-crossings --reason "<why>"` records them. A `doors` declaration may now name any member
    (`process.platform`, `process.hrtime.bigint`); the bare `process` is the whole family and exits 2,
    and so does a member Node's own `process` does not have, naming the nearest one it does
    (`process.envv` names `process.env`).
  - **A type-only import opens no door.** `import { type Stats } from "node:fs"`,
    `export { type Stats } from`, `import type x = require("node:fs")`, `import("node:fs").Stats` and
    `typeof import("node:fs")` in a type no longer count as B5 `door-outside-owner` uses of `node:fs`
    or `node:child_process`, so entries already ledgered for them are pruned on the next `--ci`. A
    file that also imports the module at run time is still one use, and inside `rules/` a type-only
    import is still the B2 import entry it was.

  The graph JSON, `ModuleNode` and `ImportEdge.typeOnly` are unchanged.

- 57f9037: `--boundaries` now sees the outside world, not only imports. One catalog names the world doors a
  file can open (`process.env`, `process.argv`, `process.stdin`/`stdout`/`stderr`/`exit`/`cwd`,
  `Date.now`, `new Date()` with no argument, `Math.random`, `crypto.randomUUID`,
  `crypto.getRandomValues`, `performance.now`, `fetch`, `setTimeout`, `setInterval`, `globalThis`,
  `console`, and the modules `node:fs` and `node:child_process`), and two checks read it:

  - **B5 `door-outside-owner`**: a `doors` key in the `--boundary-rules` file,
    `{ "<scope>": { "<door>": ["<scope-relative owner file>", …] } }`, declares who may open a door.
    A use of a declared door in any other file is a ledger entry. A declaration may be narrower than a
    catalog row (`process.stdin.isTTY` under `process.stdin`). A bad declaration (a door outside the
    catalog, a scope that declares no `features`, an owner that names no loaded file, an owner under
    `src/<feature>/rules/`) exits 2 and writes nothing.
  - **B2 `impure-rules` on globals**: inside `src/<feature>/rules/**` every use of any catalog door,
    declared or not, is now a B2 entry. Before, a rules file that read `process.env`, called `fetch`
    or asked the clock for the time passed as pure because B2 read import edges only. A repo's first
    `--ci` after upgrading lists its current uses until `--accept-crossings --reason "<why>"` records
    them.

  An entry is one file per door, so the ledger names which files still depend on a door, not how
  often. `boundary-ledger.json` gains the kind `door-outside-owner` (its `to` is `null`, as for a B2
  bare import) and an optional `"global": true` on an `impure-rules` entry for a global read by name,
  which keeps a global `fetch` and a bare `import "fetch"` from one file two entries. A ledger written
  before this change reads and gates exactly as it did. `--boundaries --migrate-ceilings` compares
  only import crossings against the recorded count and seeds the door and global entries into the
  ledger with the same reason, so a repo that predates the doors still migrates.

### Patch Changes

- 73b3187: A `doors` declaration of a mistyped `process` member is refused again. Since the `process` rows
  became one family, `process.envv` was accepted and policed nothing; it now exits 2 naming the
  door, the Node that judged it and the nearest member that Node has (`process.env`), and writes
  nothing. The members come from the running Node's own `process`, read by name at the config edge,
  so every real member stays declarable (`process.on`, `process.hrtime.bigint`, `process.stdin.isTTY`)
  and no list is kept in the catalog. The check ends at the member: what lies below it is the
  runtime's. Door detection, ledger entries and reports never consult it, so a repo gives the same
  ledger and report on every supported Node, and a member only some Nodes have
  (`process.loadEnvFile`) is refused with the Node named where the running one lacks it.
- c3eb502: A `doors` declaration of a `process` member the running process lacks is refused naming the
  platform as well as the Node version, for example `door "process.getuid" in "packages/app" is not a
member of process on Node v22.1.0 (win32).`, so a team whose CI runs on more than one host can see
  which host refused. The member set is the running process's, so it depends on the Node version, the
  platform (`process.getuid` is POSIX-only) and the launch mode (`process.send` needs an IPC channel),
  not the version alone; the README, `SPEC.md` and ADR 0023 now say so. Which declarations are
  accepted and refused does not change, and door detection, ledger entries and reports never read the
  platform, so every host still writes the same ledger and report.

## 0.2.1

### Patch Changes

- 16402be: `--layers` resolves tsconfig `paths` aliases instead of filing them as `external`.

  A bare specifier that is neither relative nor a workspace package name now resolves through the
  importing file's nearest `tsconfig.json`, `extends` followed, with the same `oxc-resolver` options
  the edge pass uses and no type-checker. An alias such as `@app/features/billing/x` that lands on a
  file inside the repo is layered and judged like a relative import, so an upward aliased import is
  now a violation. An alias that matches a `paths` key but names no file is counted and listed as
  UNRESOLVED. An npm dependency, installed or not, a node builtin and a scheme import stay
  `external`, and a repo with no tsconfig gets the same census as before.

## 0.2.0

### Minor Changes

- 0280414: `--layer-rules` path patterns gain two forms, so a layer can be declared by a file's role in its
  name rather than by its folder:

  - `**` as a whole segment matches zero or more whole path segments: `apps/**/y` claims `apps/y` and
    `apps/p/q/y`.
  - `*` inside a segment matches zero or more characters and never crosses `/`: `**/*-plumbing.ts`
    claims every `*-plumbing.ts` file at any depth.

  A whole-segment `*` keeps its one-or-more meaning, and `?`, `[...]`, `{}` and `!` stay literal.

  Specificity now compares depth (segments other than `**`), then literal segments (segments with no
  `*`), then literal characters (characters other than `*` and `/`). The first two keys are the old
  order, so a pattern using neither new form ranks as before; where two patterns tied on both, the
  old order picked one alphabetically.

  That alphabetical pick is gone. When a file's most specific patterns tie on all three keys and
  belong to different layers, `--layers` refuses: exit code 2, one line naming the file and both
  patterns, and no census or violations. A tie inside one layer is not refused.

## 0.1.0

### Minor Changes

- 28b8dbb: `--boundaries`: rule **B4** judges imports from code outside every declared feature (#393).

  Until now the pass only looked at an importer inside a declared feature or a
  `lib` folder, so under incremental adoption, with one feature declared and the
  rest of the tree undeclared, any other file could reach into a feature's
  internals unflagged. B4 closes that: a file in no declared feature and no `lib`
  folder may import a feature only through its `src/<feature>/index.ts`; any
  other file of the feature, `rules/` included, is a B4
  `outside-imports-feature-internal` violation. `lib` importers stay with B3, and
  B1–B3 verdicts are unchanged.

  Each B4 crossing is its own entry in `boundary-ledger.json`, so a scope with
  outside-to-internal imports today fails `--boundaries --ci` on every one the
  ledger does not name after upgrading. Record the ones that stay with
  `code-graph <scope> --boundaries --accept-crossings --reason "<why>"`, then
  remove them one crossing at a time.

- c874afd: `--boundaries --ci` gates a per-edge ledger instead of a per-scope count (#412).

  `boundary-ledger.json` at the repo root holds one entry per crossing import (scope, rule kind,
  importer, target or bare specifier, the specifier as written, and an optional reason), keyed by
  `(scope, kind, from, to ?? specifier)` and written sorted. The gate exits 1 only when a measured
  crossing has no entry, and lists each one, so removing one crossing and adding a different one in
  the same scope now fails. Entries whose crossing is gone are pruned from the file on every run and
  printed, never failed on. The ledger grows only through
  `--boundaries --accept-crossings --reason "<why>"`, which refuses without a reason.
  `--boundaries --write-ceilings` now exits 2 naming `--accept-crossings`; `--comments` and
  `--collapse` keep `--write-ceilings`.

  **Migration.** A repo with a `boundary-ceilings.json` runs this once, from the repo root, and
  commits the result:

  ```sh
  code-graph . --boundaries --migrate-ceilings
  ```

  It seeds `boundary-ledger.json` from the crossings measured now and deletes
  `boundary-ceilings.json`. It refuses (exit 2, nothing written) when any scope crosses more than
  its recorded count: remove the new crossings first. Until then `--boundaries --ci` exits 2 naming
  `--migrate-ceilings`.

  New subpath `@demlik/code-graph/boundaries`: the ledger schema, reader and writer, and
  `rekeyBoundaryLedgerFile(file, moves)` / `rekeyBoundaryLedger(ledger, moves)`, which re-key the
  entries whose importer or target moved so a tool that moves files keeps the ledger in step in the
  same commit.

  `InProcessGraph` (from `@demlik/code-graph/resolve`) gains `dispose()`. A graph now holds one tsgo
  session from its first `resolveExportOrigin` call instead of starting tsgo on every call, with
  the same answers. `dispose()` ends that tsgo process; a lookup after it throws.

- 9ed000f: code-graph records which function reads or writes which Workers binding (#457).

  `--data` emits one data edge per call site on a D1, Durable Object, KV, R2 or queue binding: the
  function, the binding name, its kind (from the owning worker's wrangler config) and the access —
  `read`, `write`, or `unknown` where the call site does not decide it. `--graph --data` carries the
  same report on the graph as a new top-level `data` field, `null` when the pass did not run, so
  every existing field is unchanged. The wrangler catalog now types `d1_databases`, `kv_namespaces`,
  `r2_buckets` and `queues.producers`.

- 923f36c: `--layers`: no layer stack or allowlist ships, and the gate refuses without one (#379).

  The default `layers` and `allowed` described one consumer's monorepo, so every
  other repo was gated against a stack that was never its own. Both now default to
  empty. **Migration:** if you ran `--layers` on the implicit stack, declare your
  stack in a JSON file and pass it with `--layer-rules <file>`; the README shows the
  format. `--layers` with no declared stack now exits 2 with a one-line message
  naming `--layer-rules` instead of running. A rules file that declares its own
  stack gets the same verdict and exit code as before. A failing gate's
  `Fix:` lines now point at the `allowed` array in your `--layer-rules` file.

- 8f68ec4: `--kinds` and `--unreachable` learn entrypoint-export conventions, with a built-in Next.js
  preset (#468).

  An entrypoint-export convention is a file glob, relative to the package that owns the file,
  plus the export names that count as entries in files it matches (`default` names the default
  export whatever its local name). A matched export classifies as `entry` with the convention's
  name as its evidence and roots the reachability walk, so it no longer lands in `--unreachable`
  as `dead`; an export the convention does not list is judged as before.

  The `nextjs` preset covers the app router under `app/**` and `src/app/**` (special-file default
  exports, metadata, `generateStaticParams`, route segment config, route handlers), the pages
  router under `pages/**` and `src/pages/**`, and the root `middleware` / `proxy` and
  `instrumentation` files. It activates for a package that lists `next` in `dependencies` or
  `devDependencies`, and anywhere on `--entry-preset nextjs` or `"entryExportPresets": ["nextjs"]`
  in the `--node-kinds` file. Your own conventions go under `entryExportConventions` in that file
  and add to the active presets rather than replacing them.

- a68f8f1: `--kinds`: the default node-kind rules are framework-generic only (#360).

  The defaults no longer name one consumer's own functions and SDKs. Removed:
  the `ScanCredential` / `ProjectCiBotContext` arms of `require…`, the
  `MachineToken` / `RunnerToken` / `GithubWebhookSignature` arms of `verify…`,
  `assertProjectBelongsToOrg`, `getUserMembership`, `getSessionFromHeaders`,
  the `^dodopayments:` network call, the whole `vm-spawn` effect kind and the
  `program/commands/` CLI-command path. A codebase that relied on any of them
  adds them back through `--node-kinds <file>`; the README shows how. A snapshot
  test now pins the full default set, so any later change to it is a reviewed
  diff.

- 2401a65: code-graph reads TypeScript with oxc and tsgo instead of ts-morph (#397).

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

- 4326dc5: New `--boundaries` pass
  (configured by `--boundary-rules`, gated per crossing by `boundary-ledger.json`,
  which grows only through `--accept-crossings`); one gitignore-aware file lister behind
  every pass; `--kinds` entries for `WorkerEntrypoint` / `DurableObject` public
  methods, each carrying `reach` and `guards` (Pothos `authScopes` counts);
  effects matched on the callee's declaration rather than its name; `--graph`
  with analysis flags on; end lines in `--collapse --json`; and a
  `@demlik/code-graph/project` export of `loadEdgeProject`. `--boundaries`
  declares no contract packages by default — list them under `contracts` in
  the rules file (#344).
- 47b49b6: Add lowering stages 2 to 5 to structure-sweep, and expose code-graph's SCC pass as
  `@demlik/code-graph/scc` (#423).

  - **`@demlik/code-graph/scc`** re-exports `stronglyConnectedComponents` and `sccMembers`. No CLI
    flag, JSON schema or config key changes.
  - **Stage 2, lowering** (`lowerStage`, `loweringInput`). Parses a file with `oxc-parser` and
    writes one fact per `return`, per `throw`, and per call under a non-empty
    path condition. Each fact carries atoms with their own spans and a `return` / `throw` / `call`
    outcome. Names are neutral and `console` calls (plus any added logging roots) are stripped. A
    function that does not parse lowers to `unknown` (`undetermined`).
  - **Stage 3, the lexicon** (`resolveStage`, `loadLexicon`, `proposeLexicon`).
    `structure-sweep.lexicon.json` maps an identifier to a `flag`, `entitlement`, `role`, `plan`,
    `setting` or `env` concept. Resolution is deterministic, and the lexicon's fingerprint keys the
    stage. `proposeLexicon` drafts entries through the gate and never writes over the reviewed file.
  - **Stage 4, callee summaries** (`summarize`). Walks the call graph leaves-first by SCC. Each
    summary carries return-value facts and each branch's stage-5 label as a `FactValue`. A caller's
    `=== null` check on a callee's result resolves to the callee's condition, and each SCC's key cites
    its callees' summary digests.
  - **Stage 5, the branch label** (`branchLabelQuestion`, `labelBranches`, `branchLabeller`). Labels
    are `rule`, `defence`, `plumbing` and `could-be-data`, and each criterion has a definition and
    anchoring examples. Jev names the atoms and spans it relies on before it gives the label, and that
    evidence is recorded with the answer. `evaluateAnchoring` compares the flip rate with and without
    the examples.
  - `gate`, `gateAll` and `Asker` take an optional answer type, and `Gated` now carries each item's
    `settled` outcome.

### Patch Changes

- edfac47: `--data` scopes binding aliases lexically (#463).

  An alias such as `const db = c.env.DB` used to leak into every sibling anonymous callback that
  shared its enclosing named function — or, since #460, the whole module — so a second Hono handler's
  own `db` parameter or `const db = c.env.OTHER` could resolve to the first handler's binding. Aliases
  now follow JavaScript's own scoping: every function (arrow, function expression, method, function
  declaration) opens a scope that inherits the one around it, and so does every block, `for` head,
  `switch` and `catch` for its `let`/`const`/class declarations, while a `var` stays with its
  function. A parameter or declaration of the same name shadows the outer alias only where it is in
  scope, so sibling callbacks and sibling blocks each resolve their own `db`, and an outer alias still
  reaches the code a nested block's redeclaration does not cover. Which function holds a site is
  unchanged.

- be60ee2: `--data` no longer drops binding sites silently (#460).

  A call site with no named function around it — a module-scope Hono handler,
  `app.get("/", (c) => c.env.DB.prepare(...))` — used to produce nothing. It now lands in a new
  `unattributed` array on the `DataReport`, carrying its file, line and column, and the human report
  counts it. Every data edge gains a `column`, and edges are deduplicated on it, so two same-method
  calls on one line (a read beside a write in one `db.batch([...])`) stay two edges instead of
  collapsing into the last one. Both fields are additive.

## 0.0.3

### Patch Changes

- `@demlik/code-graph/resolve` resolves. 0.0.2 shipped `exports["./resolve"]` pointing at `./src/resolve.ts`, which is not in the tarball; the export map now points at `dist/` directly instead of relying on a `publishConfig` override only `pnpm pack` applies.
