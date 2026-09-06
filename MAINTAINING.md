# MAINTAINING — `@demlik/tea`

Maintainer policy for the published contract surface. The npm export map **is** the
contract: every subpath in `package.json` `exports` carries a semver promise and a
servicing cost. This file states that promise per tier and stamps every subpath.

Vocabulary (**tier stamp**, **battery**, **showcase**) is defined below.

## Tiers

Every published subpath carries exactly one **tier stamp**:

- **`stable`** — the kernel: the core loop, the pure/testing surface, and the host
  adapters. The package's one-sentence identity ("durable event-sourced TEA for
  TypeScript") lives here. Strongest promise, slowest movement.
- **`battery`** — a published named pattern built over the kernel (resilience, flow,
  observability/persistence ops). Batteries are the differentiator and stay published,
  but they are allowed to move faster than the kernel — see the semver policy below.
- **`experimental`** — published with no stability promise. Highest strategic weight
  and least dogfooded (the agent layer); exactly the combination that must not carry a
  stability promise yet. Graduation to `battery`/`stable` is a deliberate re-stamp.

Not a tier: a **showcase** — an integration proof (the Raft showcase) that consumes the
published package like any customer. Showcases are **not published**; they live in the
a separate consumer repo, off the export map.

### Tier table — every published subpath

Canonical stamp per subpath. One row per entry in `package.json` `exports`; a new
export is not done until it has a row here. The list itself is pinned by
`src/public-doors.test.ts` — a door added or removed without that diff fails the suite.

| Subpath | Tier stamp | Notes |
|---|---|---|
| `.` | stable | the sentence: run / defineMachine / replay / supervision / ports — plus the runtime-free surface and the Sub factories |
| `./testing` | stable | testing infra is kernel |
| `./pbt` | stable | arbitraries + runners, one door |
| `./do` | stable | durable/host seam |
| `./react` | stable | |
| `./node` | stable | |
| `./mem` | stable | |
| `./extension` | stable | chrome host adapter: bridge, Subs, React hooks, `fakeChrome` |
| `./parity` | stable | grandfathered by production usage (audit-core) |
| `./devtools` | stable | dev-tooling edge of the kernel |
| `./devtools/styles.css` | stable | asset of `./devtools` |
| `./machine-viz` | stable | |
| `./package.json` | stable | metadata passthrough, not an API subpath |
| `./retry-backoff` | battery | call-hardening |
| `./agent` | experimental | agent layer; the brain migration graduates it |

### Internal parts

Everything under `src/internal/` is **not** a tier and carries no promise: the flow family, the
resilience and timing families, the persistence ops, the journal, prediction, the chart compiler.
A part lives there when it is real code the package depends on but not something a consumer is
invited to import — the way in is a published door that re-exports what it chooses to. Moving,
renaming or deleting an internal part is not a break and needs no changelog entry.

Prose that names an internal part points at its **in-tree path** (`src/internal/journal/`), never
at a `@demlik/tea/…` specifier — `src/closed-door-specifiers.test.ts` fails any tracked file under
`.patterns/` or `src/` that names a subpath `exports` does not carry.

Promoting an internal part to a door is the deliberate act this file governs: it earns a row in
the table above, a line in `src/public-doors.test.ts`, an entry in `tsup.config.ts` and a
changeset.

## Store factory per host

Each host adapter ships one factory that builds a `Store<S>` over that host's
persistence primitive. The names carry a **deliberate split**: three are
*mechanism*-named (they name the backing store) and one is *host*-named (it
names the DO host). Renaming any of them is a breaking change to a `stable`
subpath, so the split is documented here rather than flattened.

| Host adapter (subpath) | Store factory | Backing primitive | Signature | Naming |
|---|---|---|---|---|
| `./node` | `fileStore` | JSON file on disk | `fileStore<S>(path, parse)` | mechanism |
| `./mem` | `memoryStore` | in-process cell | `memoryStore<S>(initial?, parse?)` | mechanism |
| `./extension` | `chromeStorageStore` | `chrome.storage` area | `chromeStorageStore<S>(key, area?)` | mechanism |
| `./do` | `doStore` | `DurableObjectStorage` | `doStore<S>(storage, parse, key?)` | host |

`./react` is a host adapter but binds the runtime to a view; it owns no `Store`
factory and so has no row. If a future factory is added, prefer the
mechanism-named form for consistency with the majority — but do **not** rename
the existing four to converge; that break is not worth the churn (this table is
the cheaper fix).

**Journal factories are a separate family from Store factories.** A `Store<S>`
is whole-load / whole-save of one state value; a `Journal<R>`
(`src/internal/journal`, internal since #49) is an append-only, ordered record
log. `fileJournal` (`./node`, beside `fileStore`) is the one journal factory
still published, and it carries the journal's **experimental** promise, not the
`stable` stamp of the subpath it is exported from — `fileJournal` lives in
`./node` per the #30 ruling (a host file substrate homes with the host's other
file adapter), and its tier travels with the journal feature. `memoryJournal`,
the remote-sync half (#31: `RemoteJournal<R>` + `memoryRemoteJournal`,
`CursorStore` + `memoryCursorStore`, `SyncClient<R>` + `makeSyncClient`) and the
conformance suite are internal; no durable or hosted remote ships.

## Semver policy

The package is at 0.x. Semver's 0.x escape hatch is not the policy — the tier stamp is:

- **`stable`** — breaking changes are deliberate and rare. At 0.x a break in a stable
  subpath lands in a **minor** with an explicit breaking-change callout in the
  changelog; from 1.0 on it forces a **major**. This is the promise the kernel
  consumers (the `./do`/`./react`/`./extension` seam) are buying.
- **`battery`** — **may break in a minor**, before and after 1.0, provided the break is
  flagged in the changelog for that minor. A battery break never forces a major on
  kernel users who never imported it — that is the point of the tier split.
- **`experimental`** — may change or disappear in **any** release; no changelog
  obligation beyond noting the change. Do not build a stability-sensitive consumer on
  an experimental subpath.

### Removal, while 0.x

A subpath, module or exported name is removed in the **same PR** that replaces it — no
deprecated re-export is published first
([ADR 0016](./.decisions/0016-removal-lands-in-a-minor-at-0x.md)):

1. The removal, every internal import rewrite and a changeset land together. The
   changeset is `minor` for a `stable` or `battery` subpath and its breaking-change note
   names where each thing went (`./retry-backoff` → `./resilience` `{ retryBackoff }`).
   `experimental` removes silently, as its tier allows.
2. A collapse **moves parts, never drops them**: the grouped door re-exports every
   primitive of the doors it replaces. Only a genuinely dead twin — a superseded
   implementation, an inverted-name alias — is deleted, with its migration named.
3. A `@deprecated` stamp is not a holding pattern. If the removal can land now, it lands.

This section is rewritten at `1.0.0`: post-1.0, removing a `stable` subpath is a major
and earns a staged ritual written for the consumers that exist then.
