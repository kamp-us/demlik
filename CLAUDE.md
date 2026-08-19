# `@demlik/tea`

A TEA / Elm-Architecture TypeScript library for durable, replayable state machines — one pure
reducer, every host adapter. Published to npm; the export map in `package.json` **is** the
contract, and [`MAINTAINING.md`](./MAINTAINING.md) stamps every subpath with the promise it
carries. Read that before adding, moving, or widening an export.

## Doc surfaces

- [`.decisions/`](./.decisions/index.md) — the *why*, one ADR per file, plus the index row.
  Record a new one with the fabrika `adr` skill.
- [`.patterns/`](./.patterns/index.md) — how the code is shaped. Read the area before writing
  against it; where a doc contradicts your recollection, follow the doc.
- [`docs/`](./docs/README.md) — the published Diátaxis docs (tutorial / how-to / reference /
  explanation). `docs/reference/` is generated — regenerate it, never hand-edit it.
- [`ROADMAP.md`](./ROADMAP.md) — the arc-to-milestone join. What we build next, in order.
- [`MAINTAINING.md`](./MAINTAINING.md) — export tiers and the semver promise per subpath.

## Work flows through fabrika

report → triage → plan → build → review → ship. The adoption itself is recorded in
[ADR 0013](./.decisions/0013-fabrika-is-the-work-pipeline.md), which names every surface the
pipeline reads here and the one lane this repo deliberately does not adopt.

**The default unit of work is a lane, and the operator drives it.** To get an issue built,
reviewed and shipped, spawn ONE **operator** on it (`operate` skill) — it runs the builder,
reviewer and shipper shells itself, feeds every outcome back to the lane ledger, and parks to a
human only when a gate genuinely needs one. Do not hand-dispatch the per-stage shells for normal
work, and never route around them with an ad-hoc general-purpose subagent — an off-pipeline run
skips the gates.

| Work intent | Skill | Agent |
|---|---|---|
| Get one issue built → reviewed → shipped | `operate` | **operator** |
| Capture an observation / bug / idea | `report` | — |
| Classify + prioritize the backlog | `triage` | **triager** |
| Decompose a triaged epic into children | `plan-epic`, then `check-epic-plan` | — |
| Record a decision | `adr` | — |
| Record how the code is shaped | `write-pattern` | — |

The per-stage shells are for surgical use — resuming a half-dead lane, re-running one gate, or
repairing one PR — not the normal entry point:

| Stage | Skill | Agent shell |
|---|---|---|
| Implement the next issue / repair a FAIL'd PR | `build` | **builder** |
| Verify a PR against its issue's acceptance criteria | `review` | **reviewer** |
| Merge ONE verified PR | `ship` | **shipper** |
| A PR that is green but going nowhere | `heal-ci` | — |

### Setup an agent needs here

- The plugin is enabled per-repo in [`.claude/settings.json`](./.claude/settings.json): the
  `kampus` marketplace (`kamp-us/phoenix`, live-tracking) plus `fabrika@kampus`.
- The CLI is a devDependency pinned in `package.json`. Run `pnpm install`, then use the
  workspace binary — a global `fabrika` on a different version warns and may answer differently.
- Every `fabrika status` call needs `--skills-dir <the installed fabrika roster>`, or it exits
  with "no roster resolved".

### What fabrika reads here

- **The board taxonomy** — `status:needs-triage`, `status:triaged`, `status:planned`,
  `status:awaiting-release`, `ready-for:agent`, `ready-for:human`,
  `type:bug|feature|chore|decision|investigation|epic`, `p0`/`p1`/`p2`. Board config, not repo
  content.
- **The issue-shape markers** — `wayfinding:map`, `prototyping:spike`, `grilling:session`. What
  an issue *is*, as against where it sits in the pipeline.
- **`ROADMAP.md`** — the arc-to-milestone join `triage homes` reads. A row pins its milestone by
  the `#<number>` cell, never by title. `## Campaigns` rows are exactly three cells
  (`Campaign | Milestone | State`); a fourth makes the whole table unreadable.
- **`.decisions/` and `.patterns/`** — the why and the how-it-is-shaped surfaces, both already
  here. fabrika reads them and writes through `adr` / `write-pattern`; it adds no third surface.
- **`/.fabrika/`, gitignored** — per-lane machine state the CLI writes into the checkout.

What this repo does not adopt: the rendered-visual lane (`build-ui`, `review-ui`, `taste-color`)
and its `design-system-manifest.md`. `@demlik/tea` ships no UI, so there is no design law to
write and a manifest here would be a foreign opinion.

## PRs

`pnpm typecheck && pnpm lint && pnpm test` before opening one — the same commands
`.github/workflows/build.yaml` runs. `pnpm lint:worktree` is an alias of `pnpm lint` that
fabrika's `build check` invokes by that name.

Write `Closes #N` in the body, where `N` is an **issue** number — a PR number closes nothing.
Use `Refs #N` for a cross-reference only.
