# @demlik/structure-sweep

## 0.1.0

### Minor Changes

- e7297d8: `structure-sweep consolidate` proposes consolidations from the sweep and pairs
  outputs already on disk (#387): clusters of tiny files sharing scope, feature
  and role to merge, and connected `shared_helper` pairs to extract into one
  helper. It writes a JSON plan and a markdown summary and calls no model. The
  library exports `mergeProposals`, `extractProposals` and `renderConsolidation`.
- c48d822: First release. `structure-sweep sweep` asks Jev which feature and which role every source file in a
  folder belongs to, against a vocabulary the repository supplies in `structure-sweep.config.json`, and
  caches each answer by content hash and vocabulary. `structure-sweep pairs` judges
  `code-graph --collapse --json` pairs as `same_decision`, `look_alike` or `shared_helper`.
  `structure-sweep move plan|apply` moves files into `<scope>/src/<feature>/<role dir>` with their
  imports rewritten, pinning entry files — config `main`/`bin`/`exports` traced back from `dist/` to
  their source, and Next.js app-router files by convention (#345).
- 35bdcc2: `structure-sweep inventory` joins outputs already on disk into one consolidation list (#469):
  dead exports from `code-graph --unreachable`, tiny-file merges from `consolidate.json`,
  same-decision groups and shared-helper families from `pairs.json`, exported-name twins from a
  `code-graph --graph` JSON, and confirmed rule groups from the groups file. It writes
  `.structure-sweep/inventory.json` and `.structure-sweep/inventory.md`, ordered by lever and then by
  deletions, biggest first, with a content-derived id and `{ file, startLine, endLine }` spans on
  every entry. A missing input is a skipped lever, `--exclude <glob>` keeps files out of the merges,
  and it calls no model and runs no other command. The library exports exactly `buildInventory` and
  `renderInventory`, plus the type-only `Inventory`, `InventoryEntry`, `InventoryInputs`,
  `InventoryOptions`, `LeverStatus`, `Span`, `Lever`, `Source`, `UnreachableInput`, `GraphInput`,
  `ConsolidateInput` and `PairInput` (#477).
- 8eb07d3: Add the lowering foundation: stage artifacts, an evaluation harness and a confidence gate
  (#430, #427).

  - **Stage artifacts.** `runStage` caches a stage's typed facts under a key built from the input's
    content hash, the stage version and the input artifacts' digests, so an unchanged key is a hit
    that never runs the stage. Every fact carries a source span, and a value the stage isn't sure of
    is an explicit `unknown`.
  - **Evaluation harness.** `evaluate` reads a gold set (`loadGoldSet`) and asks each item under
    every rewording of the question. It reports accuracy, the flip rate, the expected calibration
    error (ECE), coverage and abstain rate, and the verdict is `shippable` only when ECE and flip rate
    are both under their thresholds. A bin count that is not a positive whole number, or a confidence
    outside [0, 1], is refused rather than skipped, and so is a gold set with no items or no
    rewording.
  - **Per-stage floor.** `calibrate` bins a stage's answers by confidence and derives the lowest floor
    whose bands all meet a stated accuracy target, or reports it `unreachable`. `evaluate` returns it
    as `calibration`.
  - **Confidence gate.** `gatePolicy({ calibration, maxRounds })` reads the floor from that
    calibration; there is no default floor. `gate` / `gateAll` promote an answer at or above the
    floor. Below the floor they enrich and re-ask for at most N rounds, then abstain the item to a
    `HumanQueue`, and it reads as `unknown` downstream.

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

- 6768130: `move plan` now needs the import graph and Jev to agree before it moves a file, and `move apply`
  commits the renames apart from the import rewrites (#411, #413).

  `move plan` reads the scope's import graph (every resolved relative import between tracked sources,
  through the scope's `tsconfig.json`). A file's graph pull is the named feature holding a strict
  majority of its import edges, both directions, to files Jev put in a named feature. A file moves
  only when that pull and Jev's feature agree and Jev's confidence clears the floor. When one side
  says move, or they name different features, the file is a `review` row. Each `review` row now
  carries both opinions, Jev's `feature`, `role` and `confidence` plus `graph: { feature, share, edges }`,
  with `feature: null` and no `share` when there is no pull. A file neither side would move is no
  longer listed, and a confident verdict with no pull no longer moves. `PlanInput` takes the
  graph as `edges`.

  `move apply` works out the import rewrite before it commits anything, and refuses to start over
  staged or unstaged changes to tracked files, or while the rewrite would change a file git does not
  track (an untracked or gitignored importer of a moved file, of any extension), naming each path.
  Untracked files the rewrite leaves unchanged stay out of its commits. It then makes two
  commits: the first holds only the renames with content unchanged, so git records each as a 100%
  rename and `git log --follow` keeps the history; the second holds the specifier rewrites, heals and
  formatting, and is skipped when nothing changed. Both are a function of `HEAD` and the manifest. A
  run that stopped after the rename commit resumes with the rewrite commit alone. The JSON report
  gains `commits: { rename, rewrite }`, and apply no longer leaves anything staged.

- d7aa608: `sweep` and `propose` now read imports, re-exports, exported names and module specifiers with
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

- af45d1d: `structure-sweep pairs --redact` keeps file paths out of what Jev sees, the `pairs` question reads
  neutrally, and two `sweep` evidence fixes (#418, #417, #419, #421).

  - **`pairs --redact`.** Jev sees each function's name and source only, so moving a file cannot move
    the answer on byte-identical bodies. `pairs.json` still records both real paths; a redacted row
    carries `"redacted": true`, and redaction is part of the pairs cache key, so a redacted run never
    reuses a plain answer or the other way round. A run without the flag sends the same state and
    writes the same rows as before.
  - **Neutral pairs wording.** The `verdict` question no longer tells Jev that a static analyser
    flagged the pair or asks what "the resemblance" means; it states what `state.a`, `state.b` and
    `state.signals` are and asks how the two functions relate. This invalidates cached `pairs`
    answers: they were given under the old wording, and the cache key (the two bodies) does not see
    the prompt, so a re-run would still serve them. Delete `pairs.json` (or pass a fresh `--out`) to
    judge every pair under the new wording. The verdict keys are unchanged.
  - **Bare imports no longer swallow the next line.** In `sweep` evidence, a bare `import "…"`
    followed by an `export … from "…"` was read as one import: the file's `imports` recorded the
    re-export's specifier instead of the bare import's, and the re-export line vanished from the
    source. Each is now its own statement: the bare import is listed in `imports` and the re-export
    stays in the source. This changes the payload for affected files, but not the verdict cache key,
    so their cached rows are reused until the file's content changes.
  - **Redacted ids no longer depend on the host locale.** `sweep --redact` numbers files in code-unit
    order instead of `localeCompare`, so the same files get the same ids on every machine.

- 224a6a2: `structure-sweep propose` reads the code, not only the names around it (#409, #415).

  - Two content signals join `signals.json` and the prompt: terms split out of every swept file's
    exported names, and import clusters — files more tightly linked by relative imports to each
    other than to the rest, each given as its member files. Every list is capped, so the prompt does
    not grow with the file count.
  - `--blind` leaves out folders, packages and code-graph clusters and names files by opaque ids
    (`f<n>`, in code-unit order of path), so a vocabulary can be drafted, and `propose` measured,
    without the folder names that encode the answer.
  - A fifth built-in role, `flows` (`flows/`), for code that orchestrates a multi-step user or
    system flow: sagas, wizards, workflows and step sequencing.

- bab1ac8: `structure-sweep propose <folder>...` gathers the signals for drafting a feature vocabulary
  (#385).

  It writes `.structure-sweep/signals.json` (folders under each folder, workspace package names,
  and code-graph clusters and cross-runtime calls when `--graph` is given) and
  `.structure-sweep/propose-prompt.md`, a prompt that asks you or your coding agent to draft the
  vocabulary, write it as a config, and check it with `sweep` and `score`. It calls no model and no
  network, reads no API key, and refuses to overwrite either file without `--force`.

- 32812a4: Add a per-function, multi-label responsibility stage to structure-sweep's lowering, and a
  deterministic rollup of it to files and folders (#456).

  - **The responsibility stage** (`responsibilityRequests`, `responsibilityStage`,
    `labelResponsibilities`). Jev is shown each function's lowered branches, their stage-3
    resolutions and its callees' stage-4 summaries, never its source. For every feature in the
    vocabulary it answers `serves` or `does-not-serve` through `gateAll`, under a `gatePolicy`
    derived from this stage's gold set. It writes one fact per (function, feature), and each reads
    through `verdictOf` as `serves`, `does-not-serve` or `unknown`. An abstained feature also goes to
    the human queue. Runs are keyed through `runStage`, so an unchanged function is a `hit`.
  - **The rollup** (`rollup`). For each file and folder and each feature, it counts the functions
    that serve it, the ones that do not, and the ones that are `unknown`, with no Jev call. A folder
    sums the files beneath it, and the output is byte-identical for the same facts.

- 611da49: `pairs` and `sweep` accept the repository root as a folder (#467).

  - **`pairs .=<collapse.json>` judges the whole-tree report.** A pair whose two
    functions sit in different top-level folders only appears in
    `code-graph . --collapse --json`, and `pairs` used to refuse `.`, so those
    pairs were never judged. The root, or any folder argument that resolves to it
    (`..` from `packages/`), is now the scope `.`: its rows carry `"scope": "."`
    and each side's repo-relative path, a second `.` run replaces only the `.`
    rows, and answers a per-folder run already gave are reused.
  - **`sweep .` judges every tracked source in the tree** and records
    `"scope": "."` on its rows.
  - A folder outside the repository is still refused, and `move` and `propose`
    still refuse the root.

- 0a65bf4: Add lowering stages 6 to 8 to structure-sweep, the derived `rederived` label, and a
  `structure-sweep groups` command that reads their artifacts back (#428, #429, #431, #458, #461).

  - **Stage 6, rule grouping** (`clusterStage`, `confirmStage`). Branches cluster on a canonical key:
    an order-independent atom set plus a normalized outcome, with lexicon concepts in place of the
    identifiers they resolve. The `--graph` JSON's `data` edges add a second candidate signal: the
    functions that touch one binding. Jev confirms each cluster through the gate (`same-rule`,
    `related-different` or `unrelated`, from a question built against a 22-group synthetic gold
    set). Only a confirmed cluster becomes a rule group; the rest go to the human queue. The new
    `deny-outcome` rule makes a `throw` and a `return false` one outcome.
  - **Stage 7, owner selection** (`ownerStage`). Picks one owner per rule group from an injected
    layer lookup and fan-in. Jev breaks only the ties those leave, and an abstained owner is
    `unknown`. `deriveRederived` marks every non-owner member `rederived`.
  - **Stage 8, the collapse handoff** (`taskSpecs`, `remeasure`, `checkRatchet`). Emits a
    schema'd task spec per settled group and re-measures the post-change tree against its expected
    delta, reporting boundary crossings added or removed through `@demlik/code-graph/boundaries`. A
    rule-group ledger fails a regrown group unless its entry carries a reason.
  - **`structure-sweep groups list | show`**. Prints the groups file (`writeGroupsFile`) as
    deterministic JSON: every group and unconfirmed cluster, or one group's members with callers,
    owner candidates, confirm evidence and human-queue entries. No Jev call.

- 33bf16b: `structure-sweep score` grades a sweep's feature vocabulary against git history
  (#383): co-change precision, recall and F1 overall and per feature, the
  leaf-folder baseline, and the share of confidently labelled rows. The library
  exports it as `scoreCoChange`, a pure function over verdict rows and change
  sets, with `readChangeSets` as its history reader.
- 4b0d7fb: `structure-sweep sweep --files <path>` judges exactly the files listed in `<path>` — one
  repo-relative path per line, or `-` for stdin — instead of whole folders, so a stratified sample
  can be swept (#408).

  Every listed path is checked against the files git tracks at `--ref`; an untracked path, one the
  sweep would never judge, or one at the repository root fails the run naming every such path before
  Jev is asked anything. `--files` cannot be combined with folders. Each file is judged over its
  parent folder's evidence, so it gets the same state a sweep of that folder gives it, and its row
  records that folder as `scope`. `runSweep` takes the same choice as `SweepOptions.files`, exclusive
  with `scopes` (the new `SweepSelection` type). A folder run's payload and verdict file are
  unchanged.

- 9ffe115: `structure-sweep sweep --nominated` asks Jev only about the files the import graph says may be
  misplaced, and reports how many Jev calls it skipped (#445).

  A file's current feature is the vocabulary feature whose folder name (`_` → `-`) is the deepest
  matching directory segment of its path. Its pull is `move plan`'s: the feature holding a strict
  majority of its import edges to files that have a current feature. A file is asked only when the
  two disagree; a file whose pull matches its folder, or that has neither, is skipped. A folder run
  reads that folder's graph; under `--files` the graph spans the nearest `tsconfig.json` scope above
  each listed file. The graph is read from the checkout, not `--ref`, and a tree with no feature
  folders asks nothing. Each folder's progress line and the summary line add the skipped count
  (files neither nominated nor cached); `SweepScopeResult` carries it as `skipped`, and
  `SweepOptions.nominate` (the new `Nominate` type) is the hook. A run without `--nominated` is
  unchanged. `graphPulls` and `agreementOf` now live in a module both commands share.

- 432adf5: `structure-sweep sweep --redact` shows Jev opaque ids instead of names (#407).

  Under it, the file's path becomes an id that keeps only its extension, every relative import
  specifier (in any import, re-export, dynamic `import()` or `require()` form, in the import list and
  in the source) becomes an id, and importing siblings and `--graph` caller/callee files are listed
  by id with their counts kept. Package specifiers are kept. `verdicts.json` still records the real
  path; redacted rows carry `"redacted": true`, and the cache never serves a redacted answer to a
  default run or the other way round. A default run's payload and verdict file are unchanged.

### Patch Changes

- bab1ac8: A `git check-ignore` that exits before reading every path (`EPIPE`), or that cannot be spawned,
  now throws the same `git check-ignore failed in <cwd> (<exit>): <reason>` error as any other
  failed run, instead of a bare `spawnSync git EPIPE` (#405). It still fails closed.
- 39dd86a: Collapse-pair candidates now exclude ignored files with non-ASCII names (#402).

  Under git's default `core.quotePath`, `git check-ignore` answered an ignored path such as
  `dist/çay.ts` as the C-quoted `"dist/\303\247ay.ts"`, so the file was never recognised as
  ignored and its pairs reached Jev — with no error. The ignore check now reads git's
  NUL-separated output, and a failed check throws instead of reading as "nothing ignored".

- 9ac4153: `sweep`, `consolidate` and `move` now include files with non-ASCII names (#400).

  Under git's default `core.quotePath`, a path such as `src/çay.ts` was listed as the
  C-quoted `"src/\303\247ay.ts"`, so `sweep` never judged the file and `consolidate` and
  `move` never saw it — with no error. Every tracked-path listing now reads git's
  NUL-separated output, so these files appear under their real paths. A sweep row's
  shape is unchanged.

- 2401a65: The mover builds its own ts-morph program (#397). `@demlik/code-graph/project` no longer exports
  `loadEdgeProject`, so `move` loads the scope's tsconfig plus every git-visible source file itself,
  the same file set it read before. No flag or output changes.
- e299ea9: `propose`'s content signals read exported names in any script whole (`ÖdemeServisi` → `ödeme`,
  `servisi`), count `export … from` re-exports as import edges so a feature behind an `index.ts`
  barrel stays one cluster, and read every file's content at `--ref` in one `git cat-file --batch`
  subprocess instead of one `git show` per file.
- 8cf28ae: `sweep --redact` numbers an alias by a file only when that file is in the tree
  `--ref` names (#471).

  - **Answers are checked against `--ref`.** The resolver still reads the
    checkout on disk, but an in-repo answer counts only when it is a file at
    `--ref`. An ignored file a `paths` fallback reaches first, an untracked file,
    a file inside a submodule (at its recorded commit or drifted), and build
    output such as a workspace package's ignored `dist/*.d.ts` now read as
    unresolved, keyed on the specifier text, so none of them gets an id.
  - **Off-ref configuration refuses.** A tsconfig-chain member or a
    `package.json` outside `node_modules` that is on disk but not at `--ref`,
    ignored or untracked, stops the run and is named as `ignored <path>` or
    `untracked <path>`. A tsconfig-chain member extended from outside the
    repository stops it too, named as `outside <path>`.
  - **An untracked source file no longer refuses.** Any other untracked file
    cannot move an answer onto a file at `--ref`, so the run goes ahead. Neither
    does a nested repository or linked worktree under the root, such as an
    ignored agent checkout: nothing inside one is a file at `--ref`. Tracked
    additions, deletions, retypes, retargeted symlinks and edits to a
    `package.json` or tsconfig-chain member still refuse, as before.

- d67fe6f: Three correctness fixes in the lowering and `sweep --redact` (#451, #452, #453).

  - **A `switch` discriminant names the outer variable.** The lowering's neutral naming resolved the
    value a `switch` switches on inside the case block's scope, so `switch (x) { case 1: let x = 2; }`
    named the case-local `x` in its path conditions. The discriminant now resolves in the enclosing
    scope, and a case body still resolves to the case's own declarations.
  - **`sweep --redact` refuses an alias answer from the wrong tree.** Aliases resolve through the
    checkout on disk, while sources come from `--ref`. When the working tree differs from `--ref` in
    anything resolution reads (a path added, removed or retyped, a tracked symlink pointing somewhere
    else, or an edited `package.json` or tsconfig in the scope's `extends` chain), the run now stops
    before asking Jev and names every such path, instead of giving an alias an opaque id read off the
    working tree. The run's own files (everything under `.structure-sweep/`, the `--out` verdict file
    and the `--config` vocabulary) never count, so a repeat run over its own untracked outputs goes
    ahead.
  - **No raw line separators in source.** `isLineEnd` writes U+2028 and U+2029 as escapes, and a
    repo test fails on either raw character in any package's `src/`.

- Updated dependencies [52f93cc]
- Updated dependencies [8907b3c]
- Updated dependencies [28b8dbb]
- Updated dependencies [c874afd]
- Updated dependencies [edfac47]
- Updated dependencies [9ed000f]
- Updated dependencies [be60ee2]
- Updated dependencies [923f36c]
- Updated dependencies [8f68ec4]
- Updated dependencies [a68f8f1]
- Updated dependencies [2401a65]
- Updated dependencies [4326dc5]
- Updated dependencies [c9bee15]
- Updated dependencies [495705d]
- Updated dependencies [72bdfa5]
- Updated dependencies [47b49b6]
  - @demlik/tea@0.19.0
  - @demlik/code-graph@0.1.0
