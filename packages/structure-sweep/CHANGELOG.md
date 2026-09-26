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
- bab1ac8: `structure-sweep propose <folder>...` gathers the signals for drafting a feature vocabulary
  (#385).

  It writes `.structure-sweep/signals.json` (folders under each folder, workspace package names,
  and code-graph clusters and cross-runtime calls when `--graph` is given) and
  `.structure-sweep/propose-prompt.md`, a prompt that asks you or your coding agent to draft the
  vocabulary, write it as a config, and check it with `sweep` and `score`. It calls no model and no
  network, reads no API key, and refuses to overwrite either file without `--force`.

- 33bf16b: `structure-sweep score` grades a sweep's feature vocabulary against git history
  (#383): co-change precision, recall and F1 overall and per feature, the
  leaf-folder baseline, and the share of confidently labelled rows. The library
  exports it as `scoreCoChange`, a pure function over verdict rows and change
  sets, with `readChangeSets` as its history reader.
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

- Updated dependencies [52f93cc]
- Updated dependencies [8907b3c]
- Updated dependencies [28b8dbb]
- Updated dependencies [923f36c]
- Updated dependencies [a68f8f1]
- Updated dependencies [4326dc5]
- Updated dependencies [495705d]
- Updated dependencies [72bdfa5]
  - @demlik/tea@0.19.0
  - @demlik/code-graph@0.1.0
