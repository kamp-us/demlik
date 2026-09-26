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

  B4 violations join each scope's existing count in `boundary-ceilings.json`, so a
  scope with outside-to-internal imports today reports `EXCEEDED` under
  `--boundaries --ci` after upgrading. Re-record the ceilings once with
  `code-graph <scope> --boundaries --write-ceilings` to freeze that debt, then
  ratchet it down.

- 923f36c: `--layers`: no layer stack or allowlist ships, and the gate refuses without one (#379).

  The default `layers` and `allowed` described one consumer's monorepo, so every
  other repo was gated against a stack that was never its own. Both now default to
  empty. **Migration:** if you ran `--layers` on the implicit stack, declare your
  stack in a JSON file and pass it with `--layer-rules <file>`; the README shows the
  format. `--layers` with no declared stack now exits 2 with a one-line message
  naming `--layer-rules` instead of running. A rules file that declares its own
  stack gets the same verdict and exit code as before. A failing gate's
  `Fix:` lines now point at the `allowed` array in your `--layer-rules` file.

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

- 4326dc5: Bring code-graph level with the copy Binclusive runs. New `--boundaries` pass
  (configured by `--boundary-rules`, gated by `boundary-ceilings.json`) sharing one
  per-scope count ratchet with `--collapse`; one gitignore-aware file lister behind
  every pass; `--kinds` entries for `WorkerEntrypoint` / `DurableObject` public
  methods, each carrying `reach` and `guards` (Pothos `authScopes` counts);
  effects matched on the callee's declaration rather than its name; `--graph`
  with analysis flags on; end lines in `--collapse --json`; and a
  `@demlik/code-graph/project` export of `loadEdgeProject`. `--boundaries`
  declares no contract packages by default — list them under `contracts` in
  the rules file (#344).

## 0.0.3

### Patch Changes

- `@demlik/code-graph/resolve` resolves. 0.0.2 shipped `exports["./resolve"]` pointing at `./src/resolve.ts`, which is not in the tarball; the export map now points at `dist/` directly instead of relying on a `publishConfig` override only `pnpm pack` applies.
