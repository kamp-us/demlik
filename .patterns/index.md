# Patterns

How the code in this repo is shaped. One row per doc — read the file for the shape itself.

The why-and-history surface is [`.decisions/`](../.decisions/index.md); this is its counterpart.
A pattern doc says *how we build it here*, an ADR says *why we chose to*.

## TEA discipline

The rules a `@demlik/tea` machine is held to, and the theory behind them.

| Doc | What it covers | Read when |
|---|---|---|
| [tea/tea-invariants.md](./tea/tea-invariants.md) | The eight properties that make a system TEA — the citation authority for substrate PRs | Changing the substrate, or citing an invariant in a commit message |
| [tea/tea-discipline.md](./tea/tea-discipline.md) | The rules every TEA touch obeys, each anchored to an exemplar commit | Designing a machine, reviewing a TEA PR, or breaking a tie between two proposals |
| [tea/elm-canon.md](./tea/elm-canon.md) | The concept-by-concept mapping from Elm/TEA to the `@demlik/tea` packages | You know the Elm idea and need its TypeScript expression here |
| [tea/naming-style.md](./tea/naming-style.md) | What to call the State / Msg / Cmd / Sub variants the canon defines | Naming the variants of a new machine's unions |
| [tea/brain-hand-seam.md](./tea/brain-hand-seam.md) | Separating the pure reducer from the adapters that do IO — the untangling recipe | Pulling a tangled feature apart, or placing a new effect |
| [tea/durable-actors.md](./tea/durable-actors.md) | The event-sourced virtual-actor target for `@demlik/tea/do` | Building or extending a Durable-Object-backed machine |
| [tea/client-prediction.md](./tea/client-prediction.md) | Client-side prediction + server reconciliation over one reducer | Building an optimistic-UI or real-time client over a machine |
| [tea/sensei-journal.md](./tea/sensei-journal.md) | Append-only log of mistakes and right shapes observed in TEA work | Starting a TEA task — recognise the shape before re-deriving it |

`tea/machine-template.ts` sits beside these: the skeleton a new machine is copied from, not a doc.

## Prior-art corpora

Two mined reference implementations, each with its own index. They teach someone else's pattern —
the mapping back to a pure reducer is an inline gloss, never product code.

| Corpus | What it covers | Read when |
|---|---|---|
| [tea/patterns/](./tea/patterns/README.md) | The Elm Architecture as a discipline, grounded in the Elm guide, elm/browser, raj, elm-ts, Lustre and Iced — 17 numbered docs plus a citation list | You want the standard an implementation is measured against, independent of this repo |
| [tea-do/](./tea-do/index.md) | Event sourcing, durable effects, projections and reentrancy, mined from Akka Persistence Typed and Microsoft Orleans — 11 docs | Designing the durable/event-sourced side of `@demlik/tea/do` |

## When to add a new pattern doc here

A doc earns a place when all four hold:

1. **It is a shape, not a decision.** The choice and its history belong in `.decisions/`; how the
   code is laid out once the choice is made belongs here.
2. **It is not consumer documentation.** Anything a package user reads goes to [`docs/`](../docs/README.md)
   under its Diátaxis quadrant. `.patterns/` is for the people writing this repo.
3. **Something already relies on it.** Write the doc for a shape the code holds today, not one you
   intend to adopt. A doc with no code behind it drifts on the first commit.
4. **No existing doc owns it.** Extend the doc that already covers the surface before adding a
   sibling; a fact in two docs is a fact that will disagree with itself.

Add the row to the right table above in the same commit as the doc. An unlisted doc is an
undiscoverable one, which is the state this index exists to end.
