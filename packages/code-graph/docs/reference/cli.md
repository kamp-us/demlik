# CLI reference

[Documentation index](../README.md)

```sh
pnpm exec code-graph <directory> [flags]
```

Requires Node.js 20 or later. Paths are relative to the working directory.
The default output is a JSON summary of counts, health, and refactor targets.

## Views

| Flag | Output |
|---|---|
| `--graph` | Complete graph as JSON |
| `--plan` | Top 20 refactor targets; `--json` includes every row |
| `--by <axis>` | Plan order: `rot` (default), `impact`, `complexity`, or `size` |
| `--smells` | Findings grouped by kind; `--json` returns the finding list |
| `--tree` | File/function tree with line ranges, metrics, and findings |
| `--hexagon` | One feature's Ports & Adapters, human text; `--json` returns the inventory |
| `--owners` | With `--boundary-rules`: who owns each table, binding and technology of the declared scopes, and who reaches into the tables; `--json` returns it as data |
| `--file <file>` | One module and its functions |
| `--blast <id>` | Direct and transitive callers of a function |
| `--find <name>` | Every function and top-level declaration with that name, as JSON |
| `--html` | Standalone HTML report; enables call analysis |

`--by impact` requires call analysis. A blast target may be a unique name or a
function id. Id paths are relative to the analyzed directory: a scan of `src`
uses `orders.ts:charge`. Ambiguous names exit 1. `--tree --json` returns the
full graph.

`--find` always prints JSON (`--pretty` indents it): `{ name, scope, matches }`.
Each match has `id`, `name`, `kind`, `file`, `line`, `isExported`, and `uses`, a
list of `{ file, line, kinds, members }`. A function's uses are its call sites. A
declaration's are every place the type checker resolves to it. `kinds` says how
the name is used on that line (`import`, `export`, `type`, `value`), and `members`
lists the properties read straight off it there, so `orderSchema.parse(input)`
is a `value` use with `members: ["parse"]`. Several matches exit 0. No
match prints an empty list, warns on stderr, and exits 0.

## Feature hexagon

`code-graph <featureDir> --hexagon` reads `ports.ts`, immediate `application/*.ts`
files, and adapter files recursively under `adapters/driving/` and
`adapters/driven/`. It needs no tsconfig or model. `--json`, `--pretty` and `--out`
work as on other views.

Sections appear in this order: Commands, External systems, Other bags, Ports
declared in ports.ts but in no bag, Use cases, Adapters, Not read. Empty sections
print `none`. JSON fields are `feature`, `commands`, `externalSystems`,
`otherBags`, `unbaggedPorts`, `useCases`, `adapters` and `notRead`.

Only direct exported `ForX` function/reference type aliases and non-generic bags
of plain typed properties are read. Optional properties are allowed. A bag may be
written as one type literal, as an intersection (`A & { ... }`), as an interface
that extends others, or as an alias of another bag, and its members are those of
every part. A part that is a name must be declared exactly once in `ports.ts`
itself, exported or not. A bag is read whole or not at all: a name that comes from
another file, is declared twice, is qualified, takes type arguments or loops back,
and a member name written in two parts, leave the whole bag in Not read, with a
reason that names the operand and the cause.

The factory must be a direct exported function declaration or `const`
arrow/function expression at module top level in `application/*.ts`. Its exported
binding name `createX` selects `X` and `XDriven`. Export lists, namespaces and
re-exports are not factories. Without a factory, the one pair `X` and `XDriven`
that `ports.ts` exports names the feature, as `Stock` and `StockDriven` do
whatever the folder is called. With no such pair, or two, print
`Factory: not found` and put every readable bag under Other bags; JSON `feature`
is `null`.

Commands and External systems hold the members of the feature's `X` and `XDriven`
bags. A list whose bag is not read prints the row that says so in place of `none`,
`not read: ports.ts:5 Orders: union type`, and `--json` holds
`{ "notRead": { "file", "line", "name", "reason" } }` where it would hold an
array; no member of that bag is printed. A `ports.ts` that does not parse or cannot
be read holds both lists the same way, with its `<source>` row, whether or not a
factory names a feature: `not read: ports.ts:1 <source>: cannot parse source`.

Every other export in `ports.ts` appears in Not read as `file:line Name: reason`.
There is no type checker, so a union, a mapped or conditional type, a generic
bag and a name from another file are not read. Port expressions
and property types stay as written. A port is used only when a readable bag
member's entire type is exactly its name. Use cases list each file's direct
exported functions. Standard source filters include tests. Lists and JSON keys
are deterministic.

Only missing `ports.ts` and unreadable selected directories exit 2. Unsupported
shapes and source failures are listed under Not read and exit 0.
The complete allowlist and ordering rules are in
[SPEC.md §14](../../SPEC.md#14-feature-hexagon---hexagon).

## Owners

`code-graph <path> --owners --boundary-rules <file>` prints, for each scope the
rules file declares at or under `<path>`, who owns its tables, bindings and
technologies and who reaches into the tables. It is a view and never a gate: it
adds no rules-file key, reads and writes no ledger, and leaves every
`--boundaries` output as it was. `--json`, `--pretty` and `--out` work as on
other views. The output is sorted and holds no timestamp or absolute path.

Each scope lists, in order:

| Section | Rows |
|---|---|
| Features | Per feature: `tables` (the names its `adapters/driven/tables.ts` exports as tables), `reach`, and the `commands` and `externalSystems` of its `ports.ts`, as `--hexagon` prints them, including a list that is not read, which holds the same `notRead` row in text and in `--json`. A feature with no `ports.ts` lists empty ports |
| Workers | Per worker, per binding: its kind, the files `bindingOwners` narrows it to, and every site with its line and place. `testFiles` are left out |
| Technologies | Per technology the scope's `interpreters` declares: its root, its modules, and every file outside the root that imports a file under it, a type-only import and a re-export included |
| Not followed | Each file with a write the run could not follow to a table, with the kind: `untraced-write`, `unloaded-module`, `default-export`, `ambiguous-star`, `export-equals` or `raw-sql`. `none` when there is no such file |
| Not read | A wrangler config that does not parse |

A `reach` row is one file's way into one table another feature owns, with the
file and its place (`feature <name> (<zone>)`, `lib`, `interpreter <technology>`
or `elsewhere`). Its `access` is the strongest of these, in this order:

| `access` | The file |
|---|---|
| `write` | Passes the table to `insert`, `update` or `delete`. These rows equal the `table-written-outside-owner` entries of `--boundaries` |
| `foreign-key` | Is itself a feature's `adapters/driven/tables.ts` and names the table |
| `read` | Names the table at run time without writing it: a select, a join or a condition |

A binding site's place is also `worker main` for the file the worker's config
names as `main`.

The view reads table facts and wrangler configs whichever kinds the rules file
lists. `testFiles` take a file out of it, and a scope not laid out per feature
lists no features. A name is followed through every re-export to the tables file
that defines it, by ECMAScript's
[ResolveExport](https://tc39.es/ecma262/#sec-resolveexport), so a write or a
read through a feature's `index.ts` or a schema barrel is a row like any other.
What it follows, what it lists under Not followed and what it leaves alone, the
same table `--boundaries` judges by:

| Case | Outcome | Why |
|---|---|---|
| `export { t } from "./m"`, `export { t as u } from "./m"` | followed | an indirect export: the table keeps the name its tables file exports it under |
| `export * from "./m"` | followed | a star export supplies every name of the module but `default` |
| `export * as ns from "./m"`, and `import * as ns from "./m"; export { ns }`, written as `ns.t` or `b.ns.t` | followed | a namespace export, entered one name at a time |
| `import { t } from "./m"; export { t }`, with or without `as` | followed | ECMA-262 files an imported, then exported, binding as an indirect export |
| A feature's own `index.ts`, a schema barrel such as `drizzle/schema.ts`, a chain of them of any length, a circle of them | followed | the walk keeps the (module, name) pairs it has visited, as ResolveExport does, so a circle ends and a name no module defines comes to nothing |
| A write whose table the run cannot trace: a variable, a call result, a parameter that shadows the import, a spread, the result of `require()` or `await import()`; or an import of a name that a file outside the tables files holds, or a member of one (`o` of `export const o = orders`, `schema.t` of `export const schema = { t }`, a table a `lib` or loose file declares) | counted as `untraced-write` | no syntax says which table it is, and the run follows a name, not a value (no data flow). A table a `lib` or loose file declares has no feature to own it, and B22 reports where it is declared. `Map#delete(key)` with a variable key is counted too, since syntax cannot tell it from a write; a literal key is not |
| A write whose table is imported from a module the run did not load: a package, a path no loaded file answers | counted as `unloaded-module` | the module may define a table a feature owns |
| A table written through `export default`, `import t from`, or `export { default as t }` | counted as `default-export` | no star supplies `default`, and a default carries no name to be the table's identity |
| A name that two `export *` supply with different bindings | counted as `ambiguous-star` | ResolveExport answers ambiguous: the module has no such export |
| A name from a module that says `export = x` | counted as `export-equals` | the export is one object whose members the syntax does not name |
| Raw SQL that begins as a write (`INSERT INTO`, `REPLACE INTO`, `UPDATE … SET`, `DELETE FROM`) in a string or a template | counted as `raw-sql` | a table named in a string is no import |
| `export type { t } from`, `export { type t } from`, `export type * from`, `import type` | neither | erased at run time: it writes nothing |
| A table passed to a helper (`insertInto(db, t)`) or to a computed member (`db["insert"](t)`) | neither | `insertInto` is any function and `["insert"]` any key; only a static member named `insert`, `update` or `delete` is a write, so the file lists as a read |
| A namespace taken whole (`...ns`, `use(ns)`), a member name (`row.orders`), an object key, an export list, a table named in raw SQL that only reads | neither | none of these is a table named at run time, and a read in raw SQL is no write to count |
| A `pgSchema(...).table(...)` declaration, `pgView`, `pgEnum`, sequences | neither | B22 reads the three constructors by name; the schema object a `.table(…)` call is made on is not resolved |

`Not followed` and the `tables:` census of `--boundaries` are one list, and the
counts are equal. Neither is a gate.

It exits 0 whatever the scopes hold. It exits 2, with one stderr line and no
report, where `--boundaries` would refuse to start: an unreadable or invalid
rules file, a path that is not a directory, or a scope the gate refuses at the
edge. The complete rules and ordering are in
[SPEC.md §15](../../SPEC.md#15-owners-view---owners).


## Function headers

`--headers` adds a `header` field to every function node in the JSON that
`--graph`, `--file <file> --json` and `--tree --json` print. Without the flag
the field is absent, and the output is unchanged.

```json
"header": {
  "text": "export function pick(a: string | number): string | number",
  "overloads": [
    { "startLine": 2, "text": "export function pick(a: string): string" },
    { "startLine": 4, "text": "export function pick(a: number): number" }
  ]
}
```

- `text` is the source as written, never reformatted. It starts where the
  node's `startLine` points: `export`, `export default`, `async`, `static` and
  other modifiers are included. It ends at the last token before the body, so
  an arrow's header ends with `=>`. A comment above the function, or between
  the header and the body, is not included.
- `overloads` lists the overload signatures written before the implementation,
  in source order, each with its own start line and without its closing `;`.
  The comments between them are left out. A function with no overloads lists
  none. Overload signatures are never function nodes; this field is the only
  place they appear.
- A node with no body, such as an `interface` accessor, runs to its end without
  the closing `;` or `,`.

## Published API

`--api <map>` prints what a package publishes, per export subpath, as a
consumer's types see it. `<directory>` is the package root. `<map>` is a JSON
file the caller writes:

```json
{
  ".": { "entry": "src/index.ts", "tier": "stable" },
  "./testing": { "entry": "src/testing/index.ts" }
}
```

Each key is a subpath. `entry` is its source file, relative to the package
root. `tier` is optional and any non-empty string; it is copied to the output
and never read. code-graph reads no `package.json` `exports` and no build
config: only the caller knows which source file a subpath comes from.

The mode runs the pinned tsgo with declaration-only emit into a temp folder
outside the checkout, using the tsconfig the package scope picks, and removes
the folder before it exits. A type error does not stop the emit; tsgo's
diagnostic count goes to stderr as one warning line. A module specifier the read
cannot resolve on the way to a published name, such as an `export *` from a
missing module in a dependency or a source `.d.ts`, prints one more warning line
naming it, and `--api` still exits 0. It prints a
`PublishedApi` JSON object with sorted keys: the package `root`, the tsgo
`compiler` version, and per subpath its `entry`, `tier` (`null` when absent)
and `names`. Each name has its declaration `text` as emitted, without
comments, and `references`: the text of every declaration it reaches that the
subpath does not publish, keyed `<emitted file>#<declared name>`. A change to
a private type therefore changes the published name that uses it.

`--api-base <rev>` diffs that view against a base commit. `<rev>` is any rev
git resolves to a commit (`origin/main`, a sha, `HEAD~1`); in CI, fetch it
first, because `actions/checkout` fetches one commit. The base commit's tree is
written from git's objects into a temp folder outside the checkout
(`git archive`), with the checkout's installed `node_modules` linked in, and
the same view runs there. The "after" side is the working tree as it is,
uncommitted edits and untracked files included. The checkout's files, index,
branch and stash are never written. It prints an `ApiDiff` JSON object: the
package `root`, the base commit's full sha as `base`, the tsgo `compiler`, and
per subpath its `tier` and three maps of names: `added` (with `after`),
`removed` (with `before`) and `changed` (with both). A name is `changed` when
its text or its references differ, so a change to a private type shows on the
published name that uses it. A subpath whose entry the base commit lacks has
every name `added`. The diff reports and does not gate: it exits 0 whatever it
finds.

```sh
code-graph packages/tea --api tea-api.json --api-base origin/main --pretty
```

`--api-policy <file>` gates that diff on the package's changesets, for a CI
job. `<file>` is a JSON bump policy the caller writes. code-graph ships no
policy and no default row:

```json
{
  "callout": "**Breaking",
  "tiers": {
    "stable": {
      "added": { "bump": "minor" },
      "changed": { "bump": "minor", "callout": true },
      "removed": { "bump": "major", "callout": true }
    },
    "experimental": {
      "added": { "bump": "none" },
      "changed": { "bump": "none" },
      "removed": { "bump": "none" }
    }
  }
}
```

- `tiers` maps a tier, as the API map spells it, to one rule per change kind.
  All three kinds, `added`, `changed` and `removed`, are required. A rule's
  `bump` is `none`, `patch`, `minor` or `major`, the least changeset bump that
  change needs. Its `callout` is optional and defaults to `false`.
- `callout` is the marker text, required and non-empty. A rule with
  `callout: true` is met only when a counted changeset's body contains it.
- A rule's `callout` can also be `{ "or": "<second marker>" }`, met when a
  counted changeset's body contains the marker text or this text. Only the rule
  that names it accepts it, so a package can let a `changed` row take a marker
  saying the change is not a break while `removed` still needs the callout. The
  check reads markers and not the change, so a marker is the author's word.
- `default` is optional and has the shape of one tier's row. It covers a
  subpath whose tier `tiers` does not name, and a subpath with no tier.
  Without it, a changed name in such a subpath exits 2 naming the subpath and
  the tier. A subpath with no change needs no row.

A changeset counts when it is a `.md` file directly in `.changeset/` at the
repo root, is not `README.md`, exists in the working tree, does not exist in
the base commit's tree, and its frontmatter gives the package (the `name` in
`<directory>/package.json`) a `major`, `minor` or `patch` bump. A changeset
for another package does not count. The highest bump among the counted files
is the bump found, `none` when no file counts, and the callout is found when
any counted file's body contains the marker.

A changed name misses when its rule's bump is above the bump found, or when
its rule asks for a callout and no marker it accepts is found. A pass prints one
line:

```text
API RATCHET: pass — 4 changes against 4b1c0de, highest changeset bump minor, callout found
```

A miss prints one block per name that misses, sorted by subpath, then name,
then a summary line. Each block names the name, subpath, tier and change kind,
the bump and callout it needs, and what was found, then the before and after
text with references (an added name has no before, a removed name no after):

```text
API RATCHET: parse in . (stable) changed — needs a minor changeset with a "**Breaking" callout; found minor with no callout
  before:
    export declare function parse(text: string): number;
  after:
    export declare function parse(text: string, radix?: number): number;
API RATCHET: 1 of 1 change misses its bump against 4b1c0de
```

`--json` prints an `ApiRatchetVerdict` instead: `passed`, the full `base` sha,
the `package` name, the counted `changesets` (repo-relative, sorted),
`highestBump`, `calloutFound`, `otherMarkersFound` (the second markers found,
sorted) and `misses`, each with `subpath`, `tier`, `name`, `kind`, `needs`
(`{ bump, callout }`), `before` and `after` (`null` where the name has none).
The same commits give the same bytes.

```sh
git fetch origin main
code-graph packages/tea --api tea-api.json --api-base origin/main --api-policy tea-bumps.json
```

| Flags | Prints | Exit |
|---|---|---|
| `--api <map>` | `PublishedApi` JSON | 0, 2, 3 |
| `--api <map> --api-base <rev>` | `ApiDiff` JSON | 0, 2, 3 |
| `--api <map> --api-base <rev> --api-policy <file>` | the verdict as text; `--json` for `ApiRatchetVerdict` | 0 pass, 1 miss, 2, 3 |
| `--api <map> --ci` | the verdict as text; `--json` for `{ passed, scope, unrecorded, pruned }` | 0 pass, 1 unrecorded name, 2, 3 |
| `--api <map> --accept-api --reason <text>` | what it added as text; `--json` for `{ scope, accepted, pruned, reason }` | 0, 2, 3 |

`--api` combines only with `--api-base`, `--api-policy`, `--json`, `--pretty`
and `--out`, or with [the API ledger's](#the-api-ledger) flags.
Exit 2, with one stderr line and nothing on stdout or in `--out`, for any other
flag beside it, a map that is not JSON or fails the schema (an unknown key, no
subpath, an empty `entry` or `tier`, an entry that is not a `.ts`, `.tsx`,
`.mts` or `.cts` file, lies outside the package or does not exist), no
tsconfig, tsgo failing to start, or an entry with no emitted file. With
`--api-base`, also for `--api-base` without `--api`, a package outside any git
repository, a rev that does not resolve to a commit, or a failed `git archive`.
With `--api-policy`, also for `--api-policy` without `--api-base`, a policy
that is not JSON or fails the schema (an unknown key, an empty `callout`, a
row missing a change kind, a `bump` outside the four), a
`<directory>/package.json` that is missing or has no `name`, a changeset
added since the base whose frontmatter does not parse, or a changed name whose
tier has no row and no `default`.
Exit 3 for any other error inside the run, in every row: one stderr line,
`code-graph: unexpected error: <message>`, no stack trace and nothing on
stdout. The diagnostics warning above is a line of its own and still comes
first when tsgo reported any. An `--out` file that cannot be written exits 3,
not 2. Exit 1 therefore always means a ratchet miss or an unrecorded name, never
a crash.
Without `--api` no emit runs and every other output is unchanged. The full
contract, with examples, is [SPEC.md §13](../../SPEC.md).

### The API ledger

A repo with no changesets can still fail lint on a new public name. `--api-base`
only reports, and `--api-policy` passes once the author adds a changeset; both
need a base commit in the checkout. The ledger needs neither. It runs no git
command, so it works on a one-commit checkout and in a folder that is not a git
repository. `api-ledger.json` sits at the repo root, beside
`unreachable-ledger.json` and `smell-ledger.json`:

```json
{
  "entries": [
    {
      "name": "parse",
      "reason": "baseline",
      "scope": "packages/core",
      "subpath": "."
    }
  ]
}
```

- An entry is keyed by `(scope, subpath, name)`. `scope` is `<directory>` relative
  to the repo root (`.` for the root itself), which keeps two packages of one
  workspace apart. `subpath` is the map's key. `reason` is required.
- It records names, never signatures. A signature change on a recorded name is not
  a failure; judging that change is what `--api-policy` is for.
- `--api <map> --accept-api --reason "<why>"` adds every published name of this
  scope that the ledger does not hold yet. It also drops this scope's entries whose
  name is gone.
- `--api <map> --ci` exits 1 on a published name of this scope that the ledger does
  not hold, and lists each by subpath and name. It never fails on an entry whose
  name is gone: it rewrites the ledger without that entry and prints it, so a second
  run changes nothing. With no ledger file every published name fails.
- A run changes only entries of its own scope, but it reads and validates the whole
  file first: a bad entry in any scope exits 2.
- On a run where the compiler reported errors, or where the read could not resolve
  a module and printed a warning naming it, nothing is pruned. A name behind a
  broken `export *` reads exactly like a removed one, so every entry the view does
  not list stays, and each is printed with a note that the compiler reported errors
  or the read could not resolve a module. New names still fail and can still be
  accepted. A blank name from a syntax error is neither listed nor recorded.
- The tradeoff: a type error anywhere in the tsconfig counts, so a package with a
  standing error never prunes. The same goes for a specifier that stays unresolved.
  The entry stays, each run names it, and the first clean run prunes it. A stale
  entry could let a removed name come back without failing; the gate takes that over
  losing a written reason.
- `--json` prints `{ passed, scope, unrecorded, pruned }` for `--ci`, and
  `{ scope, accepted, pruned, reason }` for `--accept-api`. When the compiler
  reported errors or the read could not resolve a module, `pruned` is `[]` and both
  add `unmeasured`, the entries kept with their reasons.
- Exit 2, with one line on stderr and nothing written: `--accept-api` without a
  non-empty `--reason`, with `--ci`, or without `--api`; `--reason` with `--api --ci`;
  either beside `--api-base`, `--api-policy` or any flag other than `--json`,
  `--pretty` and `--out`; and an unreadable or schema-invalid `api-ledger.json`,
  which is read before any emit. The map, tsconfig and emit refusals above apply too.

```sh
code-graph packages/core --api core-api.json --accept-api --reason "baseline"   # once
code-graph packages/core --api core-api.json --ci                               # in lint
```

The contract is [SPEC.md §13.9](../../SPEC.md).

## Analysis options

| Flag | Analysis |
|---|---|
| `--edges` | Calls, callers, resolved imports, and call-chain depth |
| `--deep` | Call analysis using the workspace-root tsconfig |
| `--cross-runtime` | Calls through Cloudflare worker bindings |
| `--kinds` | Function roles: entry, auth, effect, or plain |
| `--unreachable` | Exports with no modeled path from an entry, and exports no other file uses (`unused-export`) |
| `--unguarded` | Effects reached along a path without an auth check |
| `--clusters` | Groups of connected files compared with their folders |
| `--interface-width` | Exports and consumer files outside each package |
| `--collapse` | Similar functions and shared call blocks for review |
| `--cycles` | Groups of files in module-import cycles |
| `--data` | Access to D1, Durable Object, KV, R2, and queue bindings |
| `--hotspots` | Git churn multiplied by function complexity |
| `--env-keys` | Declared-but-unread and read-but-undeclared environment keys |
| `--comments` | Comment counts by file, package, bucket, and class |
| `--layers` | Imports that violate a declared layer stack |
| `--boundaries` | Crossings of declared feature, library, interpreter, and worker rules |

Result fields and limitations are described in [Analyses](./analyses.md).
[Layer rules](./layers.md) and [boundary rules](./boundaries.md) have their own
references.

## Pass selection and scope

The default scan uses oxc syntax only. `--data` and `--hotspots` can add results
without enabling the call graph.

`--edges`, `--deep`, `--blast`, `--find`, `--html`, `--cycles`, and
`--interface-width` enable call analysis. Other reports enable the passes they need:

| Report | Also enables |
|---|---|
| `--cross-runtime` | Call analysis |
| `--kinds`, `--clusters` | Cross-runtime and call analysis |
| `--unreachable`, `--unguarded`, `--collapse` | Node kinds, cross-runtime, and call analysis |

`--layers`, `--boundaries`, `--env-keys`, and `--comments` run separately, without
a full Graph or tsgo call analysis. Boundary checks can still require a tsconfig
to resolve imports in a declared scope.

The analyzed directory controls which files enter the graph. Package scope
chooses the nearest `tsconfig.json` at or above that directory. `--deep` chooses
one at or above the workspace root; it **does not widen the file scan**.
Cross-package callers require a directory containing those packages.

One run reads every file with that one tsconfig, so a root run does not read a
package's own `paths`. An import like `@/useda` that only the file's nearest
tsconfig resolves gives the run no use site and no call edge. `--deep` on a
package has the same limit:

- `--unreachable` withholds every export of the file that import lands on, because
  its uses are unknown. It reports none of them and names those files on stderr.
  A really unused export in such a file is reported by the package's own run and
  not by the root run, so run the gate on the package as well. The next point is
  the exception.
- A package run withholds too when a file it loads reaches an export through a
  tsconfig other than the run's own. That tsconfig is either a nested one with its
  own `paths`, such as `e2e/tsconfig.json`, or a project the `tsconfig.json`
  references, such as `tsconfig.app.json`. Neither the package run nor the root run
  reports a really unused export in that file.
- `--blast`, `calledBy` and the other graph modes still miss the calls made through
  that import.

The repo root, called the workspace root above, is the first of these that exists,
each searched upward from the analyzed directory before the next is tried:

1. The nearest ancestor with `pnpm-workspace.yaml`.
2. The nearest ancestor whose `package.json` has a `workspaces` key. A
   `package.json` that is not valid JSON does not count.
3. The nearest ancestor with a `.git` directory or file.
4. The analyzed directory.

Every ledger and ceiling file sits at this root, and `.changeset/`, repo-relative
scopes and `--deep` read it too.

An edge pass without a tsconfig exits 2.
This monorepo has package tsconfigs, so `--edges` works on a package; it has no
root tsconfig for a root `--deep` run.

## Configuration

| Flag | JSON file |
|---|---|
| `--thresholds <file>` | Partial smell-threshold overrides |
| `--node-kinds <file>` | Function-classification rules |
| `--entry-preset <name>` | Built-in entry conventions; currently `nextjs`, repeatable |
| `--layer-rules <file>` | Layer stack and allowed violations |
| `--boundary-rules <file>` | Feature, library, and worker declarations |
| `--collapse-config <file>` | Similarity and shared-block settings |

Unknown JSON keys, invalid values, and invalid patterns are rejected.
Each supplied top-level key replaces that key's default. Custom entry-export
conventions apply alongside active presets.

## Gates and baselines

| Flag | Policy |
|---|---|
| `--ci` | Fail on high-severity smells by default; with a smell ledger, check gated smells against `smell-ledger.json` |
| `--fail-on <level>` | `high` (default) or `warn`; `warn` fails on any smell |
| `--max <n>` | Also fail if the total smell count exceeds `n` |
| `--accept-smells` | Add unrecorded smells of the gated rules to `smell-ledger.json` |
| `--comments --ci` | Check ratios against `comment-ceilings.json` |
| `--collapse --ci` | Check shared-block counts against `collapse-ceilings.json` |
| `--boundaries --ci` | Check crossings against `boundary-ledger.json` |
| `--unreachable --ci` | Check unreachable and unused exports against `unreachable-ledger.json` |
| `--api <map> --ci` | Check published names against `api-ledger.json`; see [The API ledger](#the-api-ledger) |
| `--write-ceilings` | With comments: rewrite ratios. With collapse: record this scope's count |
| `--accept-crossings` | With boundaries: add unrecorded crossings to the ledger |
| `--accept-dead` | With unreachable: add unrecorded findings to `unreachable-ledger.json` |
| `--accept-api` | With `--api`: add unrecorded published names to `api-ledger.json` |
| `--dead-only` | With `--unreachable --ci`: gate only `dead` findings, not `only-called-from-tests` or `unused-export` |
| `--reason <text>` | Required, non-empty reason for `--accept-crossings`, `--accept-dead`, `--accept-smells` or `--accept-api` |
| `--migrate-ceilings` | With boundaries: replace a legacy boundary-count file with a ledger |

The ordinary smell gate is syntax-only unless call analysis is also requested.
Boundary, comment, collapse, and unreachable gates use their own policies.
Layers always gate, without needing `--ci`.

**A run takes one gate.** A second one would never run, so two of `--layers`,
`--boundaries`, `--comments`, `--collapse` and `--unreachable` in a run with
`--ci`, `--write-ceilings`, `--accept-crossings`, `--accept-dead` or
`--migrate-ceilings` exit 2 with one line naming them, before any ledger or
ceilings file is read. `--layers` counts with or without those flags.
`--env-keys`, `--hexagon` and `--owners` beside a gate, `--ci` or `--accept-smells` exit 2
the same way, since they run without one; `--owners` also takes neither
`--hexagon` nor `--env-keys` beside it. A `--ci` that rides one named gate is
not a second gate. `--api <map> --ci` and `--api <map> --accept-api` answer
before this check and take only `--json`, `--pretty` and `--out` (plus `--reason`
for the accept), so a gate flag beside them exits 2 with their own line.
To run several gates, run the command once per gate. Two reports in one run,
such as `--cycles --kinds`, are not refused: one is dropped and no gate is lost.

Boundary `--ci` can rewrite the ledger when it prunes resolved crossings.
`--boundaries --write-ceilings` is retired. Acceptance, migration, and boundary
CI are mutually exclusive. See [Adopt a boundary gate](../how-to/enforce-boundaries.md).

### The unreachable ledger

`--unreachable --ci` gates the `--unreachable` findings, and never the smells.
`unreachable-ledger.json` sits at the repo root, beside `boundary-ledger.json`:

```json
{
  "entries": [
    {
      "id": "src/shell/execute.ts:inWords",
      "kind": "dead",
      "reason": "kept for the move",
      "scope": "packages/core"
    }
  ]
}
```

- An entry is keyed by `(scope, kind, id)`. `scope` is the analyzed path relative
  to the repo root (`.` for the root itself). `kind` is `dead`,
  `only-called-from-tests` or `unused-export`. `id` is the finding's
  scope-relative id. `reason` is required.
- `unused-export` is an exported symbol, outside the public surface, that no
  other loaded file imports, re-exports or uses; a test file's import counts as
  a use. Public is the set `public-entry-surface` reads: barrels, worker mains,
  every file a `package.json` entry or `exports` target maps to (a target ending
  in `*` makes every file below it public), and what those re-export. See
  [Unused exports](./analyses.md#unused-exports).
- `--unreachable --accept-dead --reason "<why>"` adds every finding of this scope
  that the ledger does not record yet. It also drops this scope's entries whose
  finding is gone.
- `--unreachable --ci` exits 1 on a finding of this run that the ledger does not
  record, and lists each one. It never fails on an entry whose finding is gone: it
  rewrites the ledger without that entry and prints it, so the ledger only shrinks.
- A finding counts as recorded when an entry in any scope names the same symbol at
  the same kind, or an entry of another scope names the same symbol and the wider
  of the two scopes holds the kind further along `dead`, `only-called-from-tests`,
  `unused-export`. `packages/core` with `src/x.ts:f` and `.` with
  `packages/core/src/x.ts:f` are one symbol, so `code-graph .` and
  `code-graph packages/core` read one entry the same way. The kinds may differ this
  way because a run on a package alone cannot see what another package does: an
  export only another package's test calls is `dead` there and
  `only-called-from-tests` at the root, and an export a test names and another
  package's code reaches is `only-called-from-tests` there and `unused-export` at
  the root. One entry covers both runs. The reverse split counts as a code change: a
  package's `only-called-from-tests` entry does not cover a `dead` finding at the
  root, because the root sees that test too. For the same reason a package run can
  find what the root does not. A package run also finds what the root withholds as
  `uses-unknown`, except when the package's `paths` sit in a project its
  `tsconfig.json` references, or in a nested tsconfig such as `e2e/tsconfig.json`:
  its own run withholds it too, so neither run reports it
  ([Pass selection and scope](#pass-selection-and-scope)).
- A run changes only entries of its own scope, but it reads and validates the
  whole file first: a bad entry in any scope exits 2.
- All three kinds are gated by default. `--dead-only` gates only `dead`: an
  `only-called-from-tests` or `unused-export` finding neither fails the run nor
  is pruned. It reads entries by the same rule, so a package run's `dead` finding
  is covered by a root entry of `only-called-from-tests`, and a root run's is not
  covered by a package's.
- Upgrading past 0.12.0 can turn an existing `--unreachable --ci` run red: the
  `unused-export` findings it now measures are not in the ledger yet. Record them
  once with `--accept-dead --reason`, or drop their `export` keywords.
- A finding whose kind changes is a new finding unless an entry of another scope
  covers it, and its old entry is pruned either way. So one run can pass a change
  another run fails. A root run cannot tell a test added to a symbol a package
  recorded as `dead` from a test that was always in another package, so it passes
  and that package's own run fails. The same goes for a test deleted from a symbol a
  package recorded as `only-called-from-tests` when the root measures it as
  `unused-export`. If `.` and `packages/core` both record a symbol
  as `only-called-from-tests` and its only test is deleted, `packages/core` passes
  and `.` fails.
- Withheld symbols (`public-entry-surface`, `referenced-in-non-test-file`,
  `test-support-surface`, `called-by-withheld`, `uses-unknown`) are not findings
  and never enter the ledger.
- `--json` prints `{ passed, scope, gated, unrecorded, pruned }` for `--ci`, and
  `{ scope, accepted, pruned, reason }` for `--accept-dead`.
- Exit 2, with one line on stderr and nothing written: `--accept-dead` without a
  non-empty `--reason`, with `--ci`, or without `--unreachable`; `--dead-only`
  without `--unreachable --ci`; `--reason` on `--unreachable` without
  `--accept-dead`, unless `--boundaries` is also given (the boundary gate judges
  `--reason` then); and an unreadable or schema-invalid `unreachable-ledger.json`.

```sh
code-graph packages/core --unreachable --accept-dead --reason "baseline"   # once
code-graph packages/core --unreachable --ci                                # in CI
```

### The smell ledger

A plain `--ci` judges every smell in the tree. The smell ledger lets a repo gate
the rules it chooses at today's count: old smells may only shrink, and a new one
fails. `smell-ledger.json` sits at the repo root, beside the other ledgers:

```json
{
  "entries": [
    {
      "reason": "split in the core sweep",
      "rule": "big-file",
      "target": "packages/core/src/host.ts",
      "value": 900
    }
  ],
  "gated": ["big-file"]
}
```

- `gated` names the rules the repo gates, from the ten smell rules. No rule is
  gated until named. While the file is absent or `gated` is empty, `--ci` is the
  plain gate above, with the same output and exit codes.
- Once a rule is gated, `--ci` reads the ledger instead of `--fail-on` and
  `--max`. Only smells of gated rules count, at any severity. A smell of another
  rule neither fails nor is recorded.
- An entry is keyed by `(rule, target)`. `target` is relative to the repo root:
  a function's id (`<file>:<name>`, never its start line), a module's file, or a
  directory's path. `value` is the measure it may not exceed, such as a file's
  line count. `reason` is required.
- `--ci` exits 1 on a smell the ledger does not name, and on a recorded smell
  whose value grew. It lists each, with the recorded and measured value.
- `--ci` writes improvements back: an entry whose smell shrank is lowered to the
  new value, and an entry whose smell is gone is pruned. Both are printed.
- `--accept-smells --reason "<why>"` is the only way the ledger grows. It adds
  every unrecorded smell of a gated rule, and raises every recorded one that grew
  to its measured value. It also lowers and prunes as `--ci` does.
- A run changes only entries under the analyzed path, so `code-graph .` and
  `code-graph packages/core` judge `packages/core` the same way.
- `high-fan-in`, `deep-call-chain`, `dependency-cycle` and `cross-boundary-import`
  are measured only by the edge pass. Gating one turns the edge pass on, so its
  entries are always measured, never pruned unmeasured.
- A function renamed, or a file moved, is a new smell, and its old entry is
  pruned. A second function of the same name in one file renames the first id
  (`#<n>` is added).
- `--json` prints `{ passed, scope, gated, unrecorded, worsened, lowered, pruned }`
  for `--ci`, and `{ scope, gated, accepted, raised, lowered, pruned, reason }`
  for `--accept-smells`.
- Exit 2, with one line on stderr and nothing written: an unreadable or
  schema-invalid `smell-ledger.json`, including a rule name that is not a smell
  rule; `--accept-smells` without a non-empty `--reason`, with `--ci`, with no
  rule gated, or beside `--unreachable`, `--boundaries`, `--comments`,
  `--collapse` or `--layers`.

```sh
echo '{ "gated": ["big-file"] }' > smell-ledger.json                        # name the rule
code-graph packages/core --accept-smells --reason "split in the core sweep"  # once
code-graph packages/core --ci                                                # in CI
```

## Output and hotspots

| Flag | Behavior |
|---|---|
| `--json` | Return JSON for the selected view |
| `--pretty` | Indent JSON |
| `--out <file>` | Write a view directly to a file; its parent must exist |
| `--hotspots-days <n>` | Window ending now; default 90 days |
| `--hotspots-since <iso>` | Explicit start date, overriding the day count |
| `--hotspots-limit <n>` | Human-view row limit; default 20; JSON includes all rows |
| `--help` | Show the CLI's help |

`--out` keeps script-wrapper banners out of JSON and HTML. The write confirmation
goes to stderr. The ordinary smell `--ci` verdict always goes to stdout, even
when `--json` or `--out` is supplied. The smell ledger verdict follows `--json`
and `--out`.

`--graph` includes requested analysis tables. Without it, an analysis flag
selects that analysis's report. Standalone modes take precedence over graph
views. For unrelated reports, separate invocations keep the selected output clear.

## Files and failures

Scans include `.ts` and `.tsx`. Git supplies tracked and untracked files,
honoring ignore rules for untracked files. Outside git, the tool walks folders.
It excludes hidden paths, `*.d.ts`, `*.gen.ts`, `node_modules`, `vendor`, `dist`,
`.next`, and `__generated__`.

Read/parse failures appear in `parseFailures`; those files have no function
nodes. Unmatched oxc/tsgo function nodes produce a stderr warning, and their
calls remain unresolved.

| Exit | Meaning |
|---|---|
| 0 | Successful report or passing gate |
| 1 | Failed gate or missing/ambiguous blast target |
| 2 | Tool-reported input/configuration error, including a missing edge tsconfig |

The option parser also rejects unknown flags. Check stderr for the specific
error and for scope warnings.

Source: [CLI options](../../src/cli.ts), [mode selection](../../src/index.ts),
[file discovery](../../src/extract/project.ts), [published API](../../src/api/cli.ts).
