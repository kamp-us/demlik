# @demlik/structure-sweep

Sort a codebase onto its own feature vocabulary. [`@demlik/code-graph`](../code-graph) proves
structure; `structure-sweep` asks TypeSafe **Jev** what the code _means_, then moves it.

- `propose` — gather repo signals and write a prompt for drafting the feature vocabulary `sweep`
  reads, with you or your coding agent doing the drafting.
- `sweep` — for every source file under a folder, which feature it belongs to, which role it plays,
  and whether a business rule sits inside an API file.
- `pairs` — for every code-graph collapse pair, whether the two functions are the same decision,
  a look-alike, or a shared helper.
- `move plan | apply` — move files into feature folders where Jev's verdict and the import graph
  agree, committing the renames apart from the import rewrites and never moving an entry file.
- `groups list | show` — read the lowering pipeline's rule groups, owners and collapse specs back
  as JSON, with the evidence behind each group.

```sh
npm install -D @demlik/structure-sweep
```

## Jev credentials

Calls go to Jev's endpoint through [`@demlik/tea/jev`](../tea/docs/how-to/ask-jev-a-typed-question.md),
which decodes each reply; `@demlik/tea/retry-backoff` retries 429/529 and dropped connections. The
key is read from `TYPESAFE_API_KEY` — `sweep` and `pairs` refuse to start without it. `propose`,
`move` and `groups` never call Jev.

## The vocabulary file

`sweep` and `move plan` read the features and roles from `structure-sweep.config.json` at the
repository root (`--config <file>` to point elsewhere). It is parsed with zod when the command
starts; an invalid file stops the run with every problem listed, before any call is made. To
draft one for a repository you do not know yet, start with
[`propose`](#structure-sweep-propose-folder).

```json
{
  "product": "an online bookshop",
  "features": {
    "catalog": "Books, authors, editions and search over them.",
    "checkout": "Carts, payment, discounts and order placement.",
    "accounts": "Sign-up, login, sessions and a customer's profile."
  },
  "roles": {
    "business_rule": {
      "description": "Decides what is allowed or what outcome happens: eligibility, limits, pricing, status transitions.",
      "dir": "rules"
    },
    "api_surface": {
      "description": "Exposes an endpoint: parses input, calls other code, shapes output.",
      "dir": "api"
    },
    "flows": {
      "description": "Orchestrates a multi-step user or system flow: a saga, a wizard, a workflow, or the sequencing of steps across other code.",
      "dir": "flows"
    },
    "persistence": {
      "description": "Reads or writes storage: queries, repositories, caches.",
      "dir": "store"
    },
    "plumbing": {
      "description": "Generic helper with no product concept.",
      "dir": "lib",
      "shared": true
    }
  }
}
```

| Field | Meaning |
|---|---|
| `product` | Optional. One line on what the codebase is; Jev reads each file against it. |
| `features` | `lower_snake_case` key → what belongs there. At least two. A feature's folder is its key in kebab-case (`order_history` → `order-history/`). |
| `roles` | `lower_snake_case` key → `description`, the folder `dir` a file with that role lands in, and `shared` (default `false`): `true` puts the folder at `<scope>/src/<dir>` instead of under the feature. At least two. |

Answers are cached by the file's content hash **and** a fingerprint of this file, so rewording a
description re-asks every file, and an unchanged file under an unchanged vocabulary is never asked
twice.

## Commands

Folders and paths are taken relative to where you run the command; outputs default to
`.structure-sweep/` at the repository root.

`--graph` (on `sweep` and `propose`) is not yet supported for repositories with more than about 5k
source files: code-graph's ts-morph loader can hang or run out of memory there
([#384](https://github.com/kamp-us/demlik/issues/384)). Until code-graph moves off ts-morph
([#397](https://github.com/kamp-us/demlik/issues/397)), run both commands without `--graph` on
those repositories.

### `structure-sweep propose <folder>...`

```sh
structure-sweep propose apps/web/src services/api/src --graph web-graph.json
```

Writes the material for drafting a vocabulary, and leaves the drafting to whoever runs it: you, or
the coding agent you are working in (Claude Code, Codex, Cursor or any other). It calls no model and
no network, reads no API key, and reads the git tree at `--ref`, not the working copy.

It writes two files:

- `.structure-sweep/signals.json` — the folders under each folder you pass (to `--depth` levels,
  each with the number of files `sweep` would classify), every named workspace `package.json`, and,
  from each `--graph` file, the code-graph clusters that span several folders (the graph needs
  `code-graph --graph --clusters`; each cluster names the file it came from, since two graphs number
  theirs independently) and every cross-runtime `service.method` call. Beside those, two content
  signals read from the files themselves (see below). The same checkout gives byte-identical JSON.
- `.structure-sweep/propose-prompt.md` — a prompt that carries those signals, the roles to use,
  the vocabulary's JSON Schema, a filled example, the number of features to draft, and the path to
  write the config to. It names no coding agent, so any of them can follow it.

Either file already there stops the run; `--force` overwrites both.

The content signals come from what each file `sweep` would classify says, not from where it sits:

- **terms** — the exported names split into words (`parseHTTPReply` → `parse`, `http`, `reply`;
  camelCase, PascalCase and snake_case alike), with the number of files exporting a name that holds
  each word. The 60 most widespread are listed.
- **import clusters** — groups of files more tightly linked by relative imports to each other than
  to the rest, found by label propagation over the import graph. A file imported by more than 8
  others is shared plumbing and links none of its importers. Each group is given as its member files
  (up to 12, with its full size) and its 10 most common terms; the 30 largest groups are listed.

Every list is capped, so the prompt does not grow with the file count.

`--blind` drafts from the code alone. It leaves the folders, the packages and the code-graph
clusters (which code-graph gives only as folders) out of both files, and names every file in the
content signals by an opaque id — `f<n>` plus the extension, numbered in code-unit order of path, so
one checkout always gets the same ids. Cross-runtime `service.method` calls stay. The prompt says the
names were withheld on purpose, and its check step runs `sweep --redact` so the loop stays blind.
Use it to measure `propose` against a repository whose folders are the answer, or on a repository
whose folder names mislead.

The loop, by hand or by an agent reading the prompt:

1. **propose** — `structure-sweep propose <folder>...`.
2. **draft** — read `propose-prompt.md` and write the config to
   `.structure-sweep/proposed.config.json`.
3. **sweep** — `structure-sweep sweep <folder>... --config .structure-sweep/proposed.config.json`.
4. **score** — `structure-sweep score`.
5. **adjust** — merge or sharpen features with a low `confident` share, split features with low
   precision, and go back to 3 until the score stops improving.

With no `--config`, the prompt hands over five built-in roles: `business_rule` (`rules/`),
`api_surface` (`api/`), `flows` (`flows/`: code that orchestrates a multi-step user or system flow —
sagas, wizards, workflows, step sequencing), `persistence` (`store/`) and `plumbing` (`lib/`,
shared) — the ones in the example above. With `--config`, it takes that vocabulary's roles and product line instead.

| Flag | Default | |
|---|---|---|
| `--features <n>` | `12` | features the prompt asks for (at least 2) |
| `--config <file>` | five built-in roles | vocabulary to take the roles and product line from |
| `--graph <file>` | none | code-graph `--graph` JSON to read clusters and cross-runtime calls from (repeatable) |
| `--blind` | off | leave out folders, packages and code-graph clusters, and name files by opaque id |
| `--ref <ref>` | `HEAD` | git tree to read folders, packages and file content from |
| `--depth <n>` | `3` | folder levels listed under each folder (unused with `--blind`) |
| `--draft <file>` | `.structure-sweep/proposed.config.json` | where the prompt says to write the config |
| `--out <file>` | `.structure-sweep/signals.json` | signals JSON |
| `--prompt <file>` | `.structure-sweep/propose-prompt.md` | prompt |
| `--force` | off | overwrite `--out` and `--prompt` |

### `structure-sweep sweep <folder>...`

```sh
structure-sweep sweep services/api/src apps/web/src
```

Reads each folder's `.ts`/`.tsx` sources (tests, stories and `.d.ts` excluded) from the git tree
`--ref` (default `HEAD`) and writes `.structure-sweep/verdicts.json`, one row per file. A folder
that was never swept is simply all misses: the verdict file is created if absent and a new folder's
rows are added beside the others. `--graph <file>` (repeatable) passes a `code-graph --graph` JSON
as extra evidence. A file whose call fails is left out and asked again on the next run; the command
then exits 1.

`--files <path>` judges a chosen set of files instead of whole folders — a stratified sample, say:

```sh
structure-sweep sweep --files sample.txt
printf 'apps/web/src/cart.ts\nservices/api/src/billing/invoice.ts\n' | structure-sweep sweep --files -
```

`<path>` holds one repo-relative source path per line, resolved from the current directory like
`--graph`; `-` reads the list from stdin. Blank lines are skipped and a repeated path is judged
once. Every listed path is checked against the files git tracks at `--ref` before Jev is asked
anything: a path git does not track there, one the sweep would never judge (not `.ts`/`.tsx`, or a
test, story or `.d.ts`), or one at the repository root fails the run with an error naming every
such path. `--files` cannot be combined with folders; pass one or the other.

Each listed file is judged over its parent folder's evidence: the run reads every source a sweep of
that folder would read, gathers the evidence over all of them, and asks only about the listed ones.
So a sampled file gets exactly the state `structure-sweep sweep <its parent folder>` would give it,
whichever other files are listed, and its row records that folder as `scope`. Rows are cached like
a folder run's, and `--redact` applies unchanged.

`--redact` (off by default) keeps names out of what Jev sees, so it has to place a file by its
code rather than read the answer off its folder. The file's path becomes an opaque id that keeps
only the extension (`f3.tsx`); every relative specifier — in `import … from`, a bare `import "…"`,
`export … from`, `export * from`, a dynamic `import("…")` and `require("…")`, whether in the
import list or left in the source — becomes the same kind of id (`./f3`); the files that import
it are listed by their ids; and the `--graph` caller and callee file names become `g<n>` ids that
keep their `×n` counts. The ids are fixed by the input, so the same files give the same payload.
Package specifiers (`zod`, `@scope/pkg`) and path aliases are kept, as are exported names,
comments and string literals. `verdicts.json` still records each file's real path. A redacted row
is marked `"redacted": true`, and redacted and unredacted runs never share cached answers: each
asks Jev again about a file the other answered.

`--nominated` (off by default) asks Jev only about the files the import graph says may be
misplaced, instead of every file:

- **Current feature.** A file's current feature is the vocabulary feature whose folder name
  (the key with `_` turned into `-`, as `move plan` names a feature's home) matches a directory
  segment of its path. The deepest matching segment wins; with no match the file has no current
  feature. The file's own name never counts.
- **Nomination.** The run reads the import graph the way `move plan` does (resolved relative
  imports and re-exports between tracked sources, through the nearest `tsconfig.json`) and takes
  each file's pull: the current feature holding a strict majority of its import edges, both
  directions, to files that have one. A file is asked when its pull and its current feature
  disagree: they name different features, or only one of them names a feature. A file whose pull
  matches its folder, or that has neither, is skipped. A folder run reads that folder's graph;
  under `--files` the graph spans the nearest folder at or above each listed file that holds a
  `tsconfig.json`, so neighbours outside the file's own folder count.
- **Skipped count.** Each folder's progress line and the closing summary line add how many Jev
  calls were skipped: files that were neither nominated nor already cached. A cached file is
  never asked either way, so it is not counted.

The graph is read from the checkout on disk, not from `--ref`. Nomination only works in a tree
that already has some feature folders: where no file sits in one, no file has a current feature,
no file has a pull, and `--nominated` asks nothing. `--nominated` changes which files are asked,
never what a file is shown, so it combines with `--files` and `--redact` unchanged, and a
nominated row caches like any other.

### `structure-sweep pairs <folder>=<collapse.json>...`

```sh
code-graph services/api --collapse --json > api-collapse.json
structure-sweep pairs services/api=api-collapse.json
```

Asks about every collapse candidate and writes `.structure-sweep/pairs.json` plus a markdown
summary `.structure-sweep/pairs.md`, which groups `same_decision` pairs into the functions that
should become one. A pair whose two bodies were judged before keeps its answer.

`--redact` (off by default) shows Jev each function's name and source only, never its file path,
so moving a file cannot move the answer on byte-identical bodies. `pairs.json` still records both
real paths. A redacted row is marked `"redacted": true`, and redacted and unredacted runs never
share cached answers: each asks Jev again about a pair the other answered.

| Verdict | Means | Action |
|---|---|---|
| `same_decision` | Both encode the same business rule. | collapse into one function |
| `look_alike` | Similar shape, different decision. | keep apart |
| `shared_helper` | Plumbing with no rule. | extract a shared helper |

### `structure-sweep move plan --scope <folder> --feature <key>...`

Reads the sweep verdicts and the scope's import graph, and writes
`.structure-sweep/move-manifest.json`. A file moves only when two opinions agree:

- **Jev** says move when it put the file in one of the named features at or above `--floor`
  (default `0.8`).
- **The graph** says move when the file has a pull: count its relative imports, in both directions,
  to other files Jev put in a named feature, grouped by that neighbour's feature. The feature
  holding a strict majority of those edges is the pull; a tie, or no such edge, is no pull. The
  graph is every resolved relative import or re-export between two tracked sources under the scope,
  read through the scope's `tsconfig.json`, so `plan` needs one.

When both name the same feature, the file moves to `<scope>/src/<feature>/<role dir>/`, carrying
its colocated tests. When only one says move, or they name different features, the file is a
`review` row carrying both opinions — Jev's `feature`, `role` and `confidence`, and
`graph: { feature, share, edges }`, the pull's feature (`null` for none), the share of the counted
edges it holds (absent with no pull) and how many edges were counted. When neither says move, the
file is not listed. These files are **pinned** — listed, never moved:

- `package.json` `main`, `module`, `types`, `bin` and `exports` targets, and a wrangler `main`. A
  target inside the build output is traced back to the source that builds it: tsup's `entry` map,
  then tsconfig `outDir` → `rootDir`, then `dist/` → `src/`. A `bin: ./dist/index.js` pins
  `src/index.ts`.
- Next.js app-router files under `app/` or `src/app/`: every `page`, `layout`, `route`, `loading`,
  `error`, `global-error`, `not-found`, `template` and `default`, and a root `middleware` or
  `instrumentation` file.

### `structure-sweep move apply`

Carries out the manifest in two commits, so a moved file keeps its `git log --follow` and `blame`
history:

1. **Renames.** Every pending row, and each colocated test it carries, is moved with `git mv` and
   its content unchanged, so git scores each as a 100% rename.
2. **Rewrites.** ts-morph rewrites the imports and `vi.mock`-style specifiers that named a moved
   file, reading each file from the folder it was written in; any relative specifier still dangling
   is healed, and the changed files are formatted with the repository's biome when it has one. When
   none of that changes a file, there is no second commit.

Apply works out every file the rewrite will change before it commits anything. It refuses to start,
naming the paths and writing nothing, while a tracked file has staged or unstaged changes, or while
any file the rewrite would change is not tracked by git. That covers an untracked or gitignored
importer of a moved file, whatever its extension (`.mts`, `.cts`, a `.js` under `allowJs`) and
however the rewrite loaded it, including through the scope's `tsconfig.json` `include`: neither
commit could carry it. Commit, move or delete such a file, then apply again. An untracked
file the rewrite does not change is left alone and stays out of both commits. The commits are a function of `HEAD` and the manifest: two applies
of one manifest over one `HEAD` make the same trees and messages. A run that stopped after the
rename commit resumes with the rewrite commit alone, and a second `apply` over a finished manifest
commits nothing and reports `lint: "untouched"`. It prints a JSON report, including `commits`
(`{ rename, rewrite }`, the SHAs it made, `null` for one it did not) and `staleStringRefs` — old
paths still written as plain text somewhere. A row whose source and destination both exist stops
the run.

### `structure-sweep score`

```sh
structure-sweep score --since 2026-01-01 --pr-only
```

Grades the sweep's file-to-feature assignment against git history, on the idea that files in one
feature change together. It reads `.structure-sweep/verdicts.json` and `git log`, prints a table
and writes `.structure-sweep/score.json`. It calls no model and no network.

Each non-merge commit is one change set: the paths it touched that have a verdict row, deduped.
Only change sets with 2 to `--max-files` such paths are kept. A pair of files counts only when both
rows share a `scope`, the folder that was swept.

| Metric | Means |
|---|---|
| precision | Of the same-scope pairs in one feature, among files some kept change set touched, the share that changed together at least once. |
| recall | Of the same-scope pairs that changed together, the share in one feature. |
| f1 | `2PR / (P + R)`. |
| per-feature precision / recall / f1 | Precision over the pairs inside the feature; recall is co-changed pairs with both files in it over co-changed pairs with at least one. |
| leaf folders | The same precision, recall and f1 with each file's own folder as its label: the number the vocabulary has to beat. |
| confident | Rows whose feature confidence is at least `0.8`, overall and per feature, with the counts behind it. |

A metric whose denominator is zero is `null` in the JSON and `n/a` in the table.

| Flag | Default | |
|---|---|---|
| `--verdicts <file>` | `.structure-sweep/verdicts.json` | sweep output to grade |
| `--ref <ref>` | `HEAD` | read history back from here |
| `--since <date>` | all history | only commits after this date, as `git log --since` takes it |
| `--pr-only` | off | only commits whose subject ends in `(#N)`, the squash-merge shape |
| `--max-files <n>` | `40` | drop commits touching more labelled files than this |
| `--out <file>` | `.structure-sweep/score.json` | JSON report |

### `structure-sweep consolidate`

```sh
structure-sweep consolidate --max-lines 40 --min-cluster 3
```

Turns outputs already on disk into a consolidation plan: which tiny files to merge and which
plumbing to extract. It calls no model and no network, needs no `TYPESAFE_API_KEY`, and changes no
source file — it writes `.structure-sweep/consolidate.json` and a markdown summary
`.structure-sweep/consolidate.md`, nothing else. The same inputs give byte-identical JSON.

- **merge** — from the sweep verdicts: files sharing one `scope`, feature and role whose non-blank
  line count at `--ref` is at most `--max-lines`. A group with at least `--min-cluster` such files is
  one proposal.
- **extract** — from `pairs.json`: only `shared_helper` pairs, joined into one candidate wherever
  two pairs share a function, within a scope.

A missing input skips its kind with a line on stderr naming the file, and that kind is `null` in the
plan; a malformed one fails the run with its parse error.

```json
{
 "ref": "HEAD", "maxLines": 40, "minCluster": 3,
 "merge": [{ "scope": "apps/web/src", "feature": "billing", "role": "ui",
   "files": [{ "path": "apps/web/src/billing/price.tsx", "lines": 12 },
    { "path": "apps/web/src/billing/tax.tsx", "lines": 9 },
    { "path": "apps/web/src/billing/total.tsx", "lines": 7 }], "lines": 28 }],
 "extract": [{ "scope": "apps/web/src", "members": ["a.ts:fetchA", "b.ts:fetchB"], "pairs": 1 }]
}
```

Merge proposals are sorted by file count, extract candidates by member count, then pair count.

| Flag | Default | |
|---|---|---|
| `--verdicts <file>` | `.structure-sweep/verdicts.json` | sweep output |
| `--pairs <file>` | `.structure-sweep/pairs.json` | `pairs` output |
| `--ref <ref>` | `HEAD` | tree the line counts are read from |
| `--max-lines <n>` | `40` | a file is small at or under this many non-blank lines |
| `--min-cluster <n>` | `3` | small files a group needs to become a proposal (at least 2) |
| `--out <file>` | `.structure-sweep/consolidate.json` | JSON plan |
| `--report <file>` | `.structure-sweep/consolidate.md` | markdown summary |

### `structure-sweep groups`

```sh
structure-sweep groups list
structure-sweep groups show g-3f0c9a1b2d4e --graph graph.json
```

Reads the [lowering pipeline's stage 6 to 8 artifacts](#lowering-stages-68-rule-groups-owners-and-the-collapse-handoff)
back as JSON on stdout, so an agent resolving a group can pull the evidence behind it without
re-running the pipeline or reading its internals. It reads the artifacts file only: no Jev call, no
network, no `TYPESAFE_API_KEY`, and the same artifacts print byte-identical output. It never writes
source and never asks Jev anything. `unknown` stays `unknown`.

The artifacts file is what `writeGroupsFile(path, groupsFileOf({ confirmed, owners, specs }))`
writes after a run of stages 6 to 8: the stage-6 confirm artifact, the stage-7 owner artifact (or
`null` before stage 7 ran) and the stage-8 task specs, each artifact with the key and digest it was
stored under. `readGroupsFile` refuses a file that does not parse, listing every problem.

`list` prints every rule group and every candidate cluster that did not become one. `state` is
`confirmed` (a rule group), `rejected` (Jev said the members are not one rule) or `abstained`
(below the floor after every round). `owner` is set only on a confirmed group once stage 7 has run.

```json
{
  "groups": [
    { "id": "g-3f0c9a1b2d4e", "state": "confirmed", "signal": "condition", "members": 3,
      "owner": { "group": "g-3f0c9a1b2d4e", "member": "src/archive/guard.ts:guardArchive@3",
        "function": "src/archive/guard.ts:guardArchive",
        "span": { "file": "src/archive/guard.ts", "startLine": 4, "endLine": 4 } },
      "spec": true },
    { "id": "g-8d21e07c55a0", "state": "confirmed", "signal": "condition", "members": 3,
      "owner": "unknown", "spec": false },
    { "id": "g-c4b7f2e9a013", "state": "rejected", "signal": "condition", "members": 2,
      "owner": null, "spec": false }
  ]
}
```

`show <id>` prints one group or cluster (abbreviated here to one member and one candidate, with the
owner answer's distribution cut):

```json
{
  "id": "g-8d21e07c55a0",
  "state": "confirmed",
  "basis": { "_tag": "condition", "key": { "atoms": ["v0", "¬(v0.canArchive)"], "outcome": "deny" } },
  "members": [
    { "branch": "src/archive/check.ts:archiveIsAllowed@1", "function": "src/archive/check.ts:archiveIsAllowed",
      "span": { "file": "src/archive/check.ts", "startLine": 3, "endLine": 3 },
      "atoms": ["v0", "¬(v0.canArchive)"], "outcome": "return false", "bindings": [],
      "callers": ["src/ui/menu.ts:items"] }
  ],
  "owner": {
    "candidates": [
      { "function": "src/archive/check.ts:archiveIsAllowed", "member": "src/archive/check.ts:archiveIsAllowed@1",
        "span": { "file": "src/archive/check.ts", "startLine": 3, "endLine": 3 }, "layer": null, "fanIn": 1 }
    ],
    "settledBy": "jev",
    "owner": "unknown"
  },
  "evidence": {
    "differences": [{ "ref": "m0", "atoms": [], "outcome": "return false" }],
    "answer": { "label": "same-rule", "confidence": 0.95,
      "probabilities": { "same-rule": 0.95, "related-different": 0.025, "unrelated": 0.025 } },
    "rounds": 0
  },
  "questions": [
    { "stage": "owner", "span": { "file": "src/archive/check.ts", "startLine": 3, "endLine": 3 },
      "tied": ["src/archive/check.ts:archiveIsAllowed", "src/archive/guard.ts:guardArchive"],
      "answer": { "label": "c0", "confidence": 0.1, "probabilities": { "c0": 0.1, "…": 0.1 } },
      "rounds": 1 }
  ],
  "spec": null
}
```

- `members`: each member branch with its `SourceSpan`, its lowered atoms and outcome, and
  `callers`, the member function's `edges.calledBy` from the `--graph` JSON.
- `owner`: every candidate stage 7 narrowed to (not only the winner), what settled it (`layer`,
  `fan-in` or `jev`) and the owner, or `unknown`. `null` for a cluster that is not a group, or before
  stage 7 ran.
- `evidence`: stage 6's confirm evidence: the differences Jev was shown and the answer the gate
  settled on, with Jev's whole distribution.
- `questions`: the human-queue entries stage 6 (`group-confirm`: a rejected or abstained cluster)
  or stage 7 (`owner`: an owner that is `unknown`) wrote for this group.
- `spec`: the stage-8 task spec, or `null` when the group has none.

| Flag | Default | |
|---|---|---|
| `--artifacts <file>` | `.structure-sweep/groups.json` | the groups file |
| `--graph <file>` | (required for `show`) | code-graph `--graph` JSON, for each member's callers |

## As a library

Every command except `propose` is also a function — `runSweep`, `runPairs`, `planScope` /
`planManifest`, `applyManifest`, `scoreCoChange` over rows and change sets with `readChangeSets` as
its git reader, `mergeProposals` / `extractProposals` / `renderConsolidation` for
`consolidate`, and `readGroupsFile` / `listGroups` / `showGroup` for `groups` — and each
Jev-calling one takes its `JevClient` as an argument, so a caller can hand it a stub.

## Lowering: stage artifacts, the evaluation harness and the confidence gate

The foundation the staged lowering pipeline builds against. No command uses it yet: each piece is a
library function, and each Jev-calling one takes its client as an argument.

**Stage artifacts.** A `Stage<V>` has a `name`, a `version` and a `run` that writes `Fact<V>`s. Every
fact carries a `SourceSpan` (file plus 1-based inclusive lines), and its value is either `known`,
with the basis it is known on (`derived` from source, or `promoted` by the gate), or `unknown`, with
a reason. There is no arm for a guess, and `unknown` carries no answer. `runStage(store, stage,
input)` keys the run on the stage name, its version, the hash of `input.content` and the `digest`
of every input artifact, in order. An unchanged key is a `hit` answered from the store without
running the stage; changing any part is `computed`. `memoryArtifactStore()` is the store.

**Evaluation harness.** `evaluate({ question, gold, connect, thresholds, target })` asks every
gold item under the question's own `instructions` and under each rewording, through the client
`connect` builds for that wording. It reports:

- `accuracy`: the share of all answers, under every wording, that match the gold label.
- `flipRate`: the share of items whose label is not the same under every wording.
- `ece`: the expected calibration error over all answers, in equal-width confidence bins (`bins`,
  10 by default).
- `calibration`: accuracy per non-empty confidence band, and the stage's floor derived from it
  (below).
- `coverage`: the share of items whose answer under the question's own wording clears that floor,
  so the gate would promote them on the first ask. `abstainRate` is the rest.
- `verdict`: `shippable` only when ECE and flip rate are both strictly under their thresholds, else
  `not-shippable` naming each metric that is not.

`bins` must be a positive whole number and every confidence Jev returns must be in [0, 1]. Anything
else is a `RangeError`, never a skipped answer, so a bad input cannot pull ECE down to 0 and read
`shippable`. `expectedCalibrationError` refuses the same inputs. `evaluate` also refuses a gold set
with no items or no rewording with a `GoldSetError`, before it asks Jev anything: no items would score
ECE and flip rate 0 on no answers, and one wording alone can never flip. `GoldSet` types both arrays
as non-empty, and `evaluate` checks again for a set built outside the type system.

**The floor is derived, per stage.** `calibrate(scored, { target, bins })` bins scored answers by
confidence and walks down from the top band. The floor is the lower edge of the lowest band such that
it and every non-empty band above it are at least `target` accurate, with empty bands skipped. That
is `{ _tag: "derived", floor, target, bands }`. When even the top band misses the target, the result
is `{ _tag: "unreachable" }` and no answer from that stage can be promoted. `evaluate` returns this as
`calibration`, and `calibrate` is the only way to build a `derived` one.

**Gold-set format.** A gold set is a JSON file read by `loadGoldSet(file, labels)`:

```json
{
  "stage": "branch-label",
  "rewordings": ["Does this branch decide who may do something, or only move data?"],
  "items": [
    {
      "id": "a",
      "span": { "file": "src/access/can-edit.ts", "startLine": 12, "endLine": 18 },
      "state": { "source": "if (user.role !== \"owner\") return deny();" },
      "gold": "gate"
    }
  ]
}
```

`rewordings` holds at least one alternative to the question's `instructions`. Each item's `state`
is what Jev is shown, and `gold` must be one of the question's criteria keys. An unknown label or a
repeated `id` is refused with every problem listed.

**Confidence gate.** `gatePolicy({ calibration, maxRounds })` sets one stage's rule. It takes the
stage's `derived` calibration and reads the floor off it: there is no default floor and no way to pass
a bare number. `gate(item, { policy, ask, enrich })` promotes an answer at or above the floor. A below-floor item is passed to `enrich`
for more context and asked again, for at most `maxRounds` rounds, and then it abstains. `decide`
is the pure step, and its outcome is `promoted`, `retrying` (with the round about to run) or
`abstained`. `gateAll(stage, items, options)` returns the facts for the next stage and a
`HumanQueue` holding each abstained item's span, final answer and round count. An abstained item's
fact is `unknown`, so no downstream stage reads it as an answer.
`gateAll` also returns `settled`, each item's final outcome in item order. A stage whose answer
carries more than a label and a confidence types it as the gate's second parameter
(`GateOptions<K, J>`), and the gate returns that answer unchanged in `settled` and in the queue.

## Lowering stages 2–5: branches, the lexicon, callee summaries and the branch label

Four stages built on that foundation. Each is a library export and none is a command yet. Stage 5
is the only one that asks Jev.

**Stage 2, lowering** (`lowerStage`). `loweringInput({ file, source, functions, loggingRoots })`
builds a file's input from its text and the `--graph` JSON function nodes (`readLoweringGraph`
reads `id`, `file`, `startLine`, `endLine` and `edges.calls`). The file is parsed with `oxc-parser`.
For every function the graph names in the file, the stage writes one `Fact<LoweredBranch>` per
`return`, per `throw`, and per call statement reached under a non-empty path condition. Each fact
carries:

- **A path condition** made of atoms, each with its own span. An atom is one comparison, one
  predicate call, one `in` / `instanceof`, or one truthiness test. `&&` is flattened into the
  conjunction, `!` is the atom's polarity (`!==` is a negated `===`), and `||` stays one `any` atom
  over its disjuncts. An early exit carries its negation into every later branch, so in
  `if (a) return; if (b) throw …` the throw runs under `¬a ∧ b`. A `switch` dispatches as
  JavaScript does: a `default` runs when no case anywhere in the switch matches, and a body that
  falls through carries the conditions of every case that reaches it, so `case "a": default:`
  admits `"a"`.
- **An outcome** from the closed union `return` / `throw` / `call`.
- **Neutral names.** Parameters and locals are renamed `v0`, `v1`, … in declaration order,
  resolved by scope: a name declared only inside a callback or block renames nothing outside it.
  Free identifiers (imports, globals, member paths rooted at them, and callee names) keep their
  names. A call is bound to its code-graph `calleeId` when exactly one call edge on its line names
  it. Parentheses, type assertions, optional chaining and `await` are dropped, because none of them
  changes what a branch decides.
- **No logging.** Calls rooted at `console`, plus any root in `loggingRoots` such as `logger`, are
  dropped. Every other call stays.

A function that does not parse, or that the graph names but the parser cannot find, lowers to one
fact whose value is `unknown` with reason `undetermined`, never to a partial branch list. Of the
prototype's resolver rules, only `parameter-defaults-ignored` is ported: a parameter's default
contributes no atom, binding or call. It is listed in `LOWERING_RULES`.

**Stage 3, the lexicon** (`resolveStage`). `structure-sweep.lexicon.json` sits beside
`structure-sweep.config.json` and maps an identifier (a callee name or member path) to a concept:

```json
{
  "entries": {
    "features.isOn": { "kind": "flag", "concept": "project-caps" },
    "grants.has": { "kind": "entitlement", "concept": "add-ons" }
  }
}
```

`kind` is one of `flag`, `entitlement`, `role`, `plan`, `setting` or `env`, and any other kind is
refused. `loadLexicon` / `parseLexicon` compute a `fingerprint`, and `resolveInput(lexicon,
stage2Artifact)` puts that fingerprint in the stage-3 key. Editing the lexicon therefore re-runs
stage 3 while stage 2 stays a hit. Resolution is an exact lookup with no Jev call, and an
identifier with no entry stays `unresolved`.

`proposeLexicon({ resolved, limit, gate })` asks the gate about the `limit` most frequent
unresolved identifiers (`lexiconQuestion`, over the six kinds plus `none`). It returns a draft
of the promoted entries plus the abstention queue. `writeLexiconDraft` writes that draft to
`structure-sweep.lexicon.draft.json` beside the lexicon, never over it; a human reviews it and
moves entries across.

**Stage 4, callee summaries** (`summarize`). The call graph from `edges.calls[].calleeId` is
condensed with `@demlik/code-graph/scc` and walked leaves-first, one `runStage` per SCC. Each SCC
labels its branches through stage 5 with every callee's summary already written, then summarizes
its members as one unit, so a mutually recursive group is one run. A `FunctionSummary` carries:

- **Return-value facts**, `returns <value> ⇐ <condition>` (`renderReturnFact`), read off the
  function's own return branches together with the concepts that condition resolved to.
  `resolveReturns` uses them to turn a caller's `=== null`, `== null` or truthiness check on the
  callee's result (directly, or through a `const` bound to the call) into the callee returns it
  selects. `const caps = loadCaps(org); if (caps === null) …` resolves to
  `returns null ⇐ ¬(features.isOn("project-caps"))`.
- **Each branch's stage-5 label** as a `FactValue`. A label that settled below the floor reads
  `unknown`, never a label.

An SCC's key cites its callees' summary-artifact digests, along with its own members' stage-3 facts
and the labeller's question and policy. A changed leaf re-summarizes only its ancestors.

**Stage 5, the branch label** (`label.ts`). `branchLabelQuestion()` is a `ChoiceQuestion` over
exactly `rule`, `defence`, `plumbing` and `could-be-data`. Each criterion carries a definition and
at least one worked, synthetic anchoring example (`BRANCH_LABEL_CRITERIA`), and
`branchLabelQuestion({ anchors: false })` asks with the definitions alone. Jev is asked on
`branchLabelState(request)`: the lowered branch's atoms (each with a ref and a span), its outcome,
its bindings and resolved concepts, its callees' returns and labels, and the return checks stage 4
resolved. It never sees the raw function.

Evidence comes before the verdict. `branchLabelQuestions` asks one yes/no per atom and one for the
outcome, all ahead of `verdict`, and `askBranchLabel` records a `BranchJudgement`: the label, the
confidence, and the atoms and spans the label rests on. `labelBranches` gates through `gateAll`
under a `gatePolicy` built from stage 5's calibration, so an abstained branch becomes an `unknown`
fact and a human-queue entry with its evidence. `branchLabeller` wraps this as the labeller the
stage-4 walk calls. `evaluateAnchoring({ gold, connect, thresholds, target })` evaluates one gold
file with and without the anchoring examples, evidence first in both. Comparing the two flip rates
against a live Jev is one call.

## Lowering stages 6–8: rule groups, owners and the collapse handoff

Three stages on top of stages 2 and 3, each a library export. `structure-sweep groups` reads their
artifacts back; nothing here writes source.

**Stage 6, rule grouping** (`group.ts`). Duplicate logic used to be found only as pairs of whole
functions. Stage 6 finds N branches, in differently named functions, that encode one rule. It works
in two halves.

1. **Deterministic candidates** (`clusterStage`, `clusterInput(resolved, graph.data)`). Each
   stage-3-resolved branch reduces to a canonical key (`conditionKey`): its atoms as a sorted,
   order-independent set, and its normalized outcome. Stage 2's neutral names already remove local
   and parameter names, and an identifier the lexicon resolved reads as its concept
   (`⟨flag project-caps⟩`). Branches with equal keys form one candidate cluster. With the `--graph`
   JSON's `data` (`readGroupingGraph`; code-graph's `--data`), the branches of every function whose
   data edges touch one binding, keyed by `ownerService`, `bindingKind` and `binding`, form one
   candidate too, whatever their atoms. `method` and `access` do not narrow that key, so a read and a
   write of one binding are one candidate for Jev to judge. `unattributed` sites name no function
   and are never read. With no `data` (null, or absent) the clusters are exactly the condition-key
   ones. A cluster needs at least two branches from at least two functions, its id is a hash of its
   basis (`clusterId`), and this half makes no Jev call.
2. **Jev confirms each cluster** (`confirmStage`). `groupConfirmQuestion()` is a `ChoiceQuestion`
   over `same-rule`, `related-different` and `unrelated`, asked per cluster through `gateAll` under a
   `gatePolicy` built from stage 6's calibration. Jev is shown the members' lowered branches and the
   differences between them (`clusterQuestionState`), never raw source. The criteria name what
   counts as a surface (a thrown error against a returned `false`, an error type, names, a
   parameter-default value) and what makes a different rule (a subject, threshold, permission,
   consequence, or a read against a write). The question was designed against a hand-labelled,
   synthetic gold set of 22 candidate groups (`test/fixtures/lowering/group-confirm.gold.json`):
   same-rule positives on different surfaces, and related-but-different negatives.

Only a cluster confirmed `same-rule` becomes a **rule group** (`ruleGroups`): one fact with the
group id and every member branch's `SourceSpan`, never a pair. A rejected or abstained cluster makes
no group and becomes a `groupQueue` entry. Stage 6 adds one named resolver rule to the key,
`deny-outcome` (in `GROUPING_RULES`): a `throw` and a `return false` normalize to one outcome,
`deny`, so a guard that throws on the denied case and one that returns `false` key alike.

**Stage 7, owner selection** (`ownerStage`, `ownerInput(confirmed, { graph, layerOf, policy })`).
One owner per rule group. `layerOf(file)` is injected and returns `{ name, rank } | null`, the shape
of code-graph's `LayerRank`, where a higher rank is a lower layer. The owner candidates are the
members in the lowest layer that every member's callers reach without an upward edge; an unlayered
caller constrains nothing. Ties are broken by fan-in, the member function's `edges.calledBy` count.
Only a tie fan-in does not break, or a group with an unlayered member, is asked (`ownerQuestion()`,
through `gateAll` under a stage-7 `gatePolicy`). An abstained owner is `unknown` plus an `ownerQueue`
entry. A group no member of which every caller reaches without an upward edge is `unknown` too,
unasked. `ownerFacts` gives one fact per group: its id, the owner member and the owner's span.

**`rederived`, derived** (`deriveRederived(groups, owners)`). A branch is `rederived` when it is a
member of a confirmed rule group whose stage-7 owner is a different member; the owner's own branch
is not. Members of a group whose owner is `unknown` read `unknown`. No Jev call makes it, and it is
not a label of stage 5's question or gold set.

**Stage 8, the collapse handoff** (`handoff.ts`).

- **Task spec** (`taskSpecs(groups, owners, boundaries)`). Each group with a settled owner becomes
  a `TaskSpec`, a zod-schema'd JSON object for an operator lane: the group id and its basis, the
  owner's span, every other member's span, and the expected delta (`leaves`: the member functions
  whose branches no longer cluster with the owner once the collapse lands). The collapse edits
  source through the spans, never the lowered form. A group whose owner is `unknown` produces no
  spec.
- **Re-measure** (`remeasure(spec, after)`). Re-runs stages 2, 3 and 6 over the post-change source
  of the files the spec names, reusing hash-keyed artifacts, so an unchanged file is a `hit`. It
  returns `collapsed`, or `still-clustered` naming the member spans that still cluster on the
  spec's key. It also reports the boundary crossings on those files that the collapse added or
  removed. A crossing is a `@demlik/code-graph/boundaries` ledger entry,
  `{ scope, kind, from, to, specifier, reason? }`, and the spec carries the before-crossings as a
  ledger.
- **Ratchet.** `recordCollapse(ledger, collapsed, reason?)` records a collapsed group in a
  `RuleGroupLedger`. `checkRatchet(ledger, clusters)` fails a later measure whose cluster matches a
  recorded group's key, unless that entry carries a non-empty reason.

`groupsFileOf({ confirmed, owners, specs })` and `writeGroupsFile` store a run for
[`structure-sweep groups`](#structure-sweep-groups).
