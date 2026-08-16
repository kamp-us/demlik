# 0006 — Client-prediction fold seam + runtime-free import boundary

- **Status:** Accepted
- **Date:** 2026-06-27
- **Scope:** the API contract for epic #186 (the client-prediction surface of
  `@demlik/tea`). Two forks only — **the replay/fold seam shape** and **how the
  runtime-free import boundary is enforced**. No implementation; this records the
  choices the build children cite: #211 (seam), #212 (ack), #213 (boundary +
  guard), #214 (reconcile). The long-form purity canon is
  [`.patterns/tea/tea-invariants.md`](../.patterns/tea/tea-invariants.md).

## Context

Implementing client-side prediction + server reconciliation (the Gambetta/Valve
authoritative-server netcode pattern) over a `@demlik/tea` machine surfaced a
gap: there is no blessed way to **reuse the authoritative reducer on the client
to replay a queue of un-acked inputs**. The reducer is reachable only through
`run(...).dispatch`; a consumer had to reach *past* it to a
hand-extracted pure sub-step and a hand-rolled `lastAckedSeq`. tea's whole thesis
is "one pure reducer, both sides," so this must become a guarantee, not a
hand-roll. Two coupled forks block the build children, and this ADR settles both.

**Fork 1 — the seam shape.** `replay` (`packages/tea/src/index.ts` ~:2300) is
*already* a pure `init` + `update` fold: it takes `{ msgs, ctx, loaded? }`,
returns `{ state, cmds, subs }`, touches no `Store`/interpret/subscribe, and
reads the reducer-vs-transitions form via the same `formOf(machine)` reader
`run` uses (so the two agree by construction). It even accepts a base state via
`loaded` — its non-null branch is a pure passthrough, and it **throws** if the
machine's `init` emits Cmds on rehydrate (`TEA contract violation: machine.init
must return [state, []] … when loaded is non-null`). So the base-state entry
prediction needs *mostly exists*. The fork: **(a)** promote `replay` to a
first-class, documented client-prediction seam (cheapest), or **(b)** introduce a
distinct `foldMsgs(machine, base, msgs)` that reads as a prediction call-site and
frees `replay` to stay a test idiom. Three sub-questions must settle: canonical
name, signature (a direct base-state parameter vs the `init`-via-`loaded` entry),
and return shape (does a prediction caller need `cmds`/`subs`, or just `state`?).

**Fork 2 — the runtime-free import boundary.** Importing the pure step today
tree-shakes `run`/the host out of the client bundle only by **bundler accident**,
not by a tea guarantee. The fork: a dedicated runtime-free subpath export (e.g.
`@demlik/tea/pure`), and/or an extracted pure-core module the runtime imports
*from* (never the reverse), and/or a guard test asserting the pure entrypoint's
import graph never reaches `run`.

`.glossary/TERMS.md` already fixes the relevant vocabulary: **replay** is "pure
test fold," and **Fold** is the pure `(State, Event) → State` rebuild — so a
prediction-facing `foldMsgs` slots into the established register rather than
overloading the test idiom.

## Decision

**1. Introduce a distinct `foldMsgs` as the canonical client-prediction seam;
keep `replay` unchanged as the test idiom.**

```ts
foldMsgs<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx>(
  machine: Machine<S, M, C, U, Ctx>,
  base: S,
  msgs: readonly M[],
): S
```

- **Canonical name: `foldMsgs`** — the name the epic proposed and the one that
  reads at a prediction call-site (`foldMsgs(machine, snapshot, pendingInputs)`
  *is* the Gambetta reconcile step). It also matches the glossary's **Fold** term.
- **Signature: a direct positional `base` state parameter** — *not* the
  `init`-via-`loaded` entry. Prediction starts from an authoritative server
  snapshot; folding straight from `base` needs no `init` and no `ctx` (the fold
  loop calls `update(state, msg)` only — `ctx` is an `init`-only argument). A
  direct `base` param removes the coupling of reconciliation correctness to the
  machine author's `init` rehydrate discipline.
- **Return shape: just the final `state` (`S`)** — not `{ state, cmds, subs }`.
  During prediction replay the inputs' effects have *already* been sent to the
  server; re-emitting their Cmds on the client would be a double-fire bug, and
  `subs` are a runtime concern. Returning only `S` makes "replay fires no
  effects" structural rather than caller discipline. A caller that wants emitted
  Cmds for assertions uses `replay` (the test idiom), not `foldMsgs`.
- **Single-source form-branching.** `foldMsgs` reuses the existing
  `formOf(machine)` reader for reducer-vs-transitions dispatch, so it agrees with
  `run` and `replay` by construction — no second copy of the heuristic to drift.
  `replay` and `foldMsgs` share one internal fold; `replay` wraps it with the
  `init`-entry + Cmd/Sub collection, `foldMsgs` calls it from `base` and returns
  `.state`.

**On `replay`'s `loaded`/init contract (explicit, per AC):** `replay` is **kept
exactly as-is** — `{ msgs, ctx, loaded? } → { state, cmds, subs }`, including its
"`init` must return `[state, []]` (no Cmds) when `loaded` is non-null" passthrough
contract and the throw that enforces it. That contract is **retained for
replay/rehydrate/test use and is *not* the prediction base-state entry.** The
prediction base-state entry is the **separate `base` parameter added on
`foldMsgs`**, which bypasses `init` entirely. So: a separate base-state parameter
is added; `replay`'s init-passthrough contract is unchanged and prediction does
not depend on it.

**2. Enforce the runtime-free boundary with all three mechanisms, layered — each
does distinct work.**

- **Extracted pure-core module** (e.g. `packages/tea/src/pure/`) holds `foldMsgs`,
  the form reader (`formOf`/`detectUpdateForm`), and the pure types (`Machine`,
  `Reducer`/`Update`, `Transitions`, `Cmd`, `Sub`, `Msg`). **The runtime (`run`,
  the host, interpret, `Store`, subscribe) imports *from* pure-core; pure-core
  imports nothing from the runtime.** This dependency direction is the actual
  decoupling — pure-core has no edge to `run`.
- **A dedicated subpath export `@demlik/tea/pure`** re-exports *only* the fold +
  pure types from pure-core. This is the public surface and the API-level
  guarantee: importing `@demlik/tea/pure` cannot reach the host, by module graph,
  not by tree-shaking luck. It follows the existing subpath convention
  (`./subs`, `./do`, `./testing`, …).
- **An import-graph guard test** (the #213 deliverable) asserts the transitive
  import graph rooted at `@demlik/tea/pure` never reaches `run`/the host/`Store`.
  This is the regression fence that keeps a future edit from quietly
  re-coupling the boundary.

**Public export surface (explicit, per AC): the seam ships on a new
`@demlik/tea/pure` subpath, not root.** Root `.` (index.ts) pulls in `run` and
the whole runtime, so re-exporting `foldMsgs` from root would *not* yield a
runtime-free import — importing `@demlik/tea` still drags the host in. A
runtime-free entrypoint requires a subpath whose module graph is pure. `foldMsgs`
*may also* be re-exported from root `.` for discoverability, but the **runtime-free
guarantee lives only on `@demlik/tea/pure`.** This implies a new
`"./pure": { "types": …, "import": … }` entry in `packages/tea/package.json`
`exports`; #213 adds it (this ADR does not edit `package.json`).

### Contract sketch (the children cite this)

`foldMsgs<S, M, C, U, Ctx>(machine, base: S, msgs: readonly M[]): S` is a pure
fold of `machine.update` over `msgs` starting from `base`, dispatching on
`formOf(machine)` so it agrees with `run`/`replay`; it touches no `Store`,
`interpret`, or `subscribe`, takes no `ctx`, calls no `init`, discards emitted
Cmds, and computes no Subs — it returns the final `S` only. It ships on a new
runtime-free `@demlik/tea/pure` subpath export (re-exporting `foldMsgs` + the
pure types), backed by an extracted pure-core module the runtime imports *from*
(never the reverse) and an import-graph guard test asserting `/pure` never
transitively reaches `run`. `replay` is unchanged (`{ msgs, ctx, loaded? } →
{ state, cmds, subs }`, the test idiom; its non-null-`loaded` init-passthrough
contract is retained and is *not* the prediction path). Downstream: **#211**
implements `foldMsgs` + pure-core; **#212**'s seq/`lastAppliedSeq` ack partition
is a separate pure function over a Model-agnostic shape; **#213** adds the
`@demlik/tea/pure` export + guard test; **#214**'s reconcile composes
`foldMsgs(machine, authoritativeSnapshot, pendingMsgs)`.

## Consequences

- **#211** builds `foldMsgs` and the extracted pure-core; it does **not** widen,
  rename, or change the return shape of `replay`. The two share one internal fold
  keyed on `formOf`.
- **#213** adds the `"./pure"` subpath to `packages/tea/package.json` `exports`
  and writes the import-graph guard test. The guard is structural (`**TDD:** no`).
- **#214** composes the settled API directly: `foldMsgs(machine, snapshot,
  pending)` over #212's pending-input partition — no re-opening of name,
  signature, or return shape.
- **Banned:** routing client prediction through `replay`'s `loaded`/`init` entry
  (couples reconciliation to the machine's rehydrate discipline and risks the
  init-Cmd throw); re-exporting the fold *only* from root `.` (defeats the
  runtime-free guarantee); a second copy of the form-branching heuristic (must
  reuse `formOf`).
- **Cost:** a small amount of internal motion — extracting pure-core and routing
  `replay`/`run` through it — and one new public subpath to maintain. The payoff
  is that "one reducer, both sides" and "the host stays out of the client bundle"
  become tea guarantees instead of a tree-shaking accident, with a guard test
  that fails loudly if either regresses.
- This **confirms** epic #186's "cheapest fix" hypothesis only partway: `replay`
  *is* already the right fold, but it stays the test idiom; prediction gets its
  own honest name and contract (`foldMsgs`) sharing `replay`'s fold internals.
