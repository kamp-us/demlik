# @demlik/structure-sweep

Sort a codebase onto its own feature vocabulary. [`@demlik/code-graph`](../code-graph) proves
structure; `structure-sweep` asks TypeSafe **Jev** what the code _means_, then moves it.

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
key is read from `TYPESAFE_API_KEY` — `sweep` and `pairs` refuse to start without it. `move` never
calls Jev.

## The vocabulary file

`sweep` and `move plan` read the features and roles from `structure-sweep.config.json` at the
repository root (`--config <file>` to point elsewhere). It is parsed with zod when the command
starts; an invalid file stops the run with every problem listed, before any call is made.

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

## As a library

Every command is also a function — `runSweep`, `runPairs`, `planScope` / `planManifest`,
`applyManifest` — and each Jev-calling one takes its `JevClient` as an argument, so a caller can
hand it a stub.
