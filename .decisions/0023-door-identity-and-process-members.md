---
id: 0023
title: A world door is named for what a use read, and Node's own process judges a declaration
status: accepted
date: 2026-10-01
tags: []
---

# 0023 — A world door is named for what a use read, and Node's own process judges a declaration

**What this decides:** how `code-graph --boundaries` tells one world door from another in the
ledger, and who decides which `process` members a `doors` declaration may name: Node does, not a
list in this repo.

## Context

Three decisions about door identity shipped inside feature PRs without a record, and the third
undid a promise the first PR made.

https://github.com/kamp-us/demlik/pull/512 ("feat: code-graph boundaries: declare one owner per
world door, and ledger every other use", issue
https://github.com/kamp-us/demlik/issues/511) added the door catalog, the B5 `door-outside-owner`
check and B2 on globals in `rules/`. https://github.com/kamp-us/demlik/pull/514 ("feat: code-graph
boundaries: a rules/ file using process.hrtime or process.platform passes as pure, and a type-only
node:fs import counts as a door use", issue https://github.com/kamp-us/demlik/issues/510) folded the
seven `process` rows into one family row. That PR's own Deviations disclosed the cost: a `doors`
declaration of `process.envv` was now accepted and policed nothing, where #511 had promised that a
door name outside the catalog exits 2. https://github.com/kamp-us/demlik/issues/516 ("code-graph
boundaries: a mistyped process door like process.envv is accepted and silently enforces nothing")
asked for the promise back, and the three decisions are recorded together because the third rests on
the other two.

## Decision

**A door is identified by the target a use read, never by the kind of read that found it, and a
`process` member a declaration names is judged against Node's own `process`, to the member and no
deeper.**

1. **The `global: true` ledger flag** (https://github.com/kamp-us/demlik/pull/512). A ledger entry
   is keyed `(scope, kind, from, to ?? specifier)`. A global read in `rules/` has a null `to` and
   the door as its `specifier`, and so does a bare-specifier import, so a global `fetch` and
   `import "fetch"` from one file would be one key. An `impure-rules` entry with a null `to` may
   carry `global: true`, an optional flag that is only ever `true`, and the flag is part of the
   entry's identity: the two are two entries.
   - Chosen against keeping the key as it was: the two crossings share one entry, so once one is
     recorded the other is never a new crossing, and closing one never prunes while the other
     stands.
   - Chosen against a new ledger `kind` for globals: that forks B2 in the schema, the report,
     `--migrate-ceilings` and every reader of `kind` to carry one bit, where an absent flag leaves
     every ledger written before it reading and gating as it did.
2. **The `process.<member>` family** (https://github.com/kamp-us/demlik/pull/514). The catalog has
   one row for `process`, shape `members`, and each static member is its own door, named for the
   member a use read: `process.hrtime()` and `process.hrtime.bigint()` are one door,
   `process.hrtime`. The seven names the catalog once listed row by row (`process.env`,
   `process.argv`, `process.stdin`, `process.stdout`, `process.stderr`, `process.exit`,
   `process.cwd`) keep their spelling, so a ledger written before the family gates unchanged.
   - Chosen against one row per member: the catalog lists seven, so `process.hrtime` and
     `process.platform` passed as pure in `rules/`, and a row per member is a list someone keeps
     in step with Node by hand.
   - Chosen against the whole `process` as one door: a use would read `process`, the seven old
     names would stop matching a recorded ledger, and an owner could not own `process.env` apart
     from `process.stdin`.
3. **A declaration is judged against Node's own `process`**
   (https://github.com/kamp-us/demlik/issues/516). A `doors` key
   naming a member of `process` is refused with exit 2, and nothing written, unless the running
   Node's `process` has that member, own or inherited (`process.on` is EventEmitter's). The names
   are read by name only, once, where the rules file is read, so no getter runs
   (`process.stdin` opens a stream). The refusal names the scope, the declared door, the nearest
   real member and the Node version that judged it. Nearest is commander's rule for a mistyped
   `--flag`: an edit distance of at most 3 and a similarity above 0.4, compared without case and
   tie-broken by name, so one typo names the same member on every run, and a member with nothing
   near is refused with no guess.
   - Chosen against accepting any identifier, which is the regression: a typo is a door nobody
     uses.
   - Chosen against a member list in the catalog, or a committed snapshot of the oldest supported
     Node's members: both are hand-kept facts the platform already owns, and a snapshot refuses
     real members of a newer Node.
   - Chosen against checking the segments below the member: what lies below one is the runtime's,
     not Node's static shape. `process.stdin.isTTY` is not a property when stdin is a pipe and
     `process.env` holds whatever keys the shell gave it, so those segments stay an identifier
     check.
   - **The Node-version rule.** The member set gates declarations only. Door detection, ledger
     entry names and report bytes never consult it, so any supported Node (`engines.node` is
     `>=20`) writes the same ledger and report for the same repo. A member present in one Node and
     absent in another (`process.loadEnvFile`, Node 20.12 and later) is judged against the Node
     running the CLI: declarable there when it has it, refused with that Node's version named when
     it does not, never silently accepted.

**Binding constraints.**

- A ledger entry for a global read carries `global: true` and nothing else tells it from a bare
  import. Any new reader of the ledger keys on the flag as well.
- The catalog keeps one `process.<member>` row. A list of `process` members never enters the repo.
- The member set reaches the declaration check as a parameter and nothing else. Detection, the
  ledger and the report never read it.

## Consequences

- A mistyped `process` member exits 2 again, as #511 promised, and a package owner reads which door
  and which Node judged it.
- A repo that declares a member newer than a contributor's Node gets a refusal naming that Node
  from the contributor's machine and a pass from CI's newer one. The ledger both write is the same.
- The nearest-member suggestion is a heuristic over Node's names. It never decides a verdict, only
  the wording of a refusal.

## Records

no vocabulary impact
