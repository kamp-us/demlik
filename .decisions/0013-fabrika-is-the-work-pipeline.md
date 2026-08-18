# 0013 — fabrika is this repo's work pipeline

- **Status:** Accepted
- **Date:** 2026-08-16
- **Scope:** how work enters, gets classified, and gets built in `kamp-us/demlik`.
  Records the surfaces this repo now carries so the pipeline can run here, and the
  ones it deliberately does not.

## Context

Work on this package arrived ad hoc: an observation lived in a session, a fix landed
straight on a branch, and nothing on the board said what was waiting or how urgent it
was. The package was extracted out of a larger monorepo that already ran a pipeline,
so the habits came along without the surfaces they needed.

fabrika is that pipeline, packaged as a CLI plus a set of skills: an observation is
filed as an issue, triage classifies and prices it, a builder picks it up, a reviewer
gates the PR, a shipper merges it. It reads the repo rather than a config file — a
label taxonomy, a decision corpus, a roadmap that joins arcs to milestones. Adopting
it is mostly a question of which of those surfaces this repo has.

## Decision

**fabrika is the way work enters and leaves this repo.** An observation becomes a
`status:needs-triage` issue; triage stamps type, priority, audience and a home; only a
triaged issue is pickable.

The surfaces that adoption needs, and where each one now lives:

- **The board taxonomy** — `status:needs-triage`, `status:triaged`, `status:planned`,
  `ready-for:agent`, `ready-for:human`, `type:bug|feature|chore|decision|investigation|epic`,
  `p0`/`p1`/`p2`, `status:awaiting-release`. Board config, not repo content.
- **The issue-shape markers** — `wayfinding:map`, `prototyping:spike`, `grilling:session`.
  What an issue *is*, as against where it sits in the pipeline.
- **[`../ROADMAP.md`](../ROADMAP.md)** — the arc-to-milestone join triage reads to answer
  "where does this live". An arc pins a milestone by its `#<number>` cell, never by title.
- **[`./`](./index.md)** — the decision corpus, which this repo already had. It stays the
  *why* surface; `.patterns/` stays the how-the-code-is-shaped surface.
- **`/.fabrika/`, gitignored** — the CLI writes per-lane machine state into the checkout.
  It is per-machine, like `.claude/settings.local.json`, and never enters history.

What this repo does **not** adopt: the rendered-visual lane (`build-ui`, `review-ui`,
`taste-color`) and its `design-system-manifest.md`. `@demlik/tea` ships no UI, so
there is no design law to write and a manifest here would be a foreign opinion.

## Consequences

- A fix no longer starts on a branch. It starts as an issue, and the branch traces to it.
- Priority becomes relative to the active arc in `ROADMAP.md` rather than to a mood, which
  means the roadmap has to be kept honest — a stale arc misprices everything under it.
- An open milestone is required for triage to home an issue. A repo with none dead-ends,
  so a release lane stays open even when it is nearly empty.
- The taxonomy is now load-bearing: a renamed or deleted label fails the pipeline closed
  rather than silently degrading it.
