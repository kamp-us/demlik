# @demlik/structure-sweep

Sort a codebase onto its own feature vocabulary. [`@demlik/code-graph`](../code-graph) proves
structure; `structure-sweep` asks TypeSafe **Jev** what the code _means_, then moves it.

- `propose` — gather repo signals and write a prompt for drafting the feature vocabulary `sweep`
  reads, with you or your coding agent doing the drafting.
- `sweep` — for every source file under a folder, which feature it belongs to, which role it plays,
  and whether a business rule sits inside an API file.
- `pairs` — for every code-graph collapse pair, whether the two functions are the same decision,
  a look-alike, or a shared helper.
- `move plan | apply` — move confidently-judged files into feature folders with their imports
  rewritten, never moving an entry file.

```sh
npm install -D @demlik/structure-sweep
```

## Jev credentials

Calls go to Jev's endpoint through [`@demlik/tea/jev`](../tea/docs/how-to/ask-jev-a-typed-question.md),
which decodes each reply; `@demlik/tea/retry-backoff` retries 429/529 and dropped connections. The
key is read from `TYPESAFE_API_KEY` — `sweep` and `pairs` refuse to start without it. `propose`
and `move` never call Jev.

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

### `structure-sweep pairs <folder>=<collapse.json>...`

```sh
code-graph services/api --collapse --json > api-collapse.json
structure-sweep pairs services/api=api-collapse.json
```

Asks about every collapse candidate and writes `.structure-sweep/pairs.json` plus a markdown
summary `.structure-sweep/pairs.md`, which groups `same_decision` pairs into the functions that
should become one. A pair whose two bodies were judged before keeps its answer.

| Verdict | Means | Action |
|---|---|---|
| `same_decision` | Both encode the same business rule. | collapse into one function |
| `look_alike` | Similar shape, different decision. | keep apart |
| `shared_helper` | Plumbing with no rule. | extract a shared helper |

### `structure-sweep move plan --scope <folder> --feature <key>...`

Reads the sweep verdicts and writes `.structure-sweep/move-manifest.json`: each file under
`<scope>/src` judged to one of the named features at or above `--floor` (default `0.8`) moves to
`<scope>/src/<feature>/<role dir>/`, carrying its colocated tests; a file below the floor is listed
for review. These files are **pinned** — listed, never moved:

- `package.json` `main`, `module`, `types`, `bin` and `exports` targets, and a wrangler `main`. A
  target inside the build output is traced back to the source that builds it: tsup's `entry` map,
  then tsconfig `outDir` → `rootDir`, then `dist/` → `src/`. A `bin: ./dist/index.js` pins
  `src/index.ts`.
- Next.js app-router files under `app/` or `src/app/`: every `page`, `layout`, `route`, `loading`,
  `error`, `global-error`, `not-found`, `template` and `default`, and a root `middleware` or
  `instrumentation` file.

### `structure-sweep move apply`

Moves every pending manifest row with ts-morph, rewrites the imports and `vi.mock`-style specifiers
that named it, heals any relative specifier a move left dangling, formats the touched files with
the repository's biome when it has one, and stages the result with `git add`. It prints a JSON
report, including `staleStringRefs` — old paths still written as plain text somewhere. A row whose
source and destination both exist stops the run. A second `apply` over the same manifest changes
nothing.

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

## As a library

Every command except `propose` is also a function — `runSweep`, `runPairs`, `planScope` /
`planManifest`, `applyManifest`, `scoreCoChange` over rows and change sets with `readChangeSets` as
its git reader, and `mergeProposals` / `extractProposals` / `renderConsolidation` for
`consolidate` — and each Jev-calling one takes its `JevClient` as an argument, so a caller can
hand it a stub.
