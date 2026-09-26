# @demlik/code-graph

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
