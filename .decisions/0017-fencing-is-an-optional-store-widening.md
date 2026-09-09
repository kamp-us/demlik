---
id: 0017
title: Fencing is an optional Store widening, and a store conflict is a throw
status: accepted
date: 2026-09-09
tags: []
---

# 0017 — Fencing is an optional Store widening, and a store conflict is a throw

**Scope:** how `@demlik/tea` refuses a second live writer against one persisted run, and what
shape that refusal takes on the `Store<S>` seam. Amends the durability story
[`docs/explanation/durability-model.md`](../docs/explanation/durability-model.md) tells;
follows [0011](./0011-errors-as-data.md) on when a failure is a throw rather than a value.

**What this decides:** an optional `FencedStore<S> extends Store<S>` carries the version and the
compare-and-swap; `Store<S>` itself does not change; a lost compare-and-swap throws
`StoreConflictError`; and fencing stays opt-in for the whole 0.x line.

## Context

`Store<S>` was `{ load, save, migrate }` — no version, no lease, no conflict. `save` was
unconditional, so the last writer won and neither writer could learn it had raced. Two resumers
started against one `agent.json` both drove the same run to done: a 3-note run wrote 7 lines to
`notes.txt`, with no error, no refusal and no warning (#143). `fileStore`'s temp-plus-rename is
atomicity of ONE write; it was never exclusion between two writers. Inside a Durable Object the
platform's single-writer guarantee hid the hole, which is why an outside review's "yes" was
conditional on DO.

The fix direction was never in doubt — a version plus a compare-and-swap. What was in doubt was
its shape, because `Store<S>` is exported from the **stable root** subpath, four in-repo adapters
implement it, and any external adapter does too. Three routes were on the table: widen `Store<S>`
itself (cleanest semantics, breaks every implementor, and forces `memoryStore` and
`chromeStorageStore` to invent a version they have no substrate for); add an optional second
interface; or leave the type alone and make single-writer a documented precondition.

## Decision

**Take the optional interface, and take the documented precondition with it.**

1. **`FencedStore<S> extends Store<S>`**, adding `fenced: true`, `loadFenced(): Promise<{ raw,
   version }>` and `saveFenced(state, expectedVersion): Promise<number>`. `Store<S>` is
   untouched, so every existing implementor — in this repo and outside it — still compiles, and
   the stable-root promise in `MAINTAINING.md` holds.
2. **The fenced methods sit BESIDE `load` and `save`, they do not override them.** A `load`
   returning `{ raw, version }` is structurally assignable to `Promise<unknown>`, so an
   override would typecheck and then hand every version-blind caller a wrapper object its
   `migrate` cannot read. Two contracts, two names.
3. **A lost compare-and-swap throws `StoreConflictError`** (`_tag: "store_conflict"`). Under
   ADR 0011 a failure is a value when the machine can fold it and carry on, and a throw when the
   contract is breached. A second claimant is a breach of the single-writer promise: there is no
   correct way for the loser to continue, and folding a conflict into the Model would mean
   persisting through the very store that just refused it.
4. **Fencing is opt-in for all of 0.x.** Every factory that can fence takes an explicit
   `{ fenced: true }`; the unfenced call is byte-for-byte the old behaviour. Whether the fenced
   path becomes the default is a separate decision for a future major.
5. **`run` fences on the store it is handed, never on a flag of its own.** It reads the version
   at boot and swaps on every save, so a run that starts from a version another process has
   already moved past is refused at its boot save — before a single effect fires.
6. **`chromeStorageStore` opts out honestly.** `chrome.storage` has no atomic compare-and-swap
   and no cross-context lock, so a version cell there would race between its own read and write
   — a fence that reports success while both writers win, which is worse than no fence.

Both sub-questions triage left open are ruled here, per the founder ruling on #143
(https://github.com/kamp-us/demlik/issues/143): the throw in (3), the opt-in default in (4).

## Consequences

- The unfenced default stays silently unsafe unless the docs say so, so the doc change is part
  of this decision rather than a follow-up: `docs/explanation/durability-model.md` now states
  both the fencing story and the single-writer requirement that applies without it.
- Two durability tiers now exist, and every page that explains the `Store` seam has to name
  which one it is describing. That is the cost bought in exchange for breaking no implementor.
- `fileStore`'s fence is a sidecar `<path>.fence` stamp guarded by the same `wx` lock file
  `fileJournal` uses — `open(…, "wx")` is the only primitive here that is atomic across
  processes, and without it the read-compare-write is a TOCTOU race that both writers pass.
  The state file's own format is unchanged, so a file written unfenced resumes fenced.
- `doStore`'s fence runs inside `storage.transaction`, so the read, the compare and both writes
  commit as one unit and a refusal rolls back.
- An external adapter gains nothing automatically. Fencing is a capability its author opts into
  by implementing two more methods; until then their store behaves exactly as it does today.
