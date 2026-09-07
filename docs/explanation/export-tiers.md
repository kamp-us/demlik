# What each import is allowed to do to you

`@demlik/tea` publishes one package with a wide import surface, and the parts of
it are not equally settled. Rather than stretch one stability promise across all
of them, every published subpath carries exactly one **tier stamp**, and the tier
is the promise.

Read the tier of what you import; it tells you how much churn you are signing up
for.

## The three tiers

**`stable` — the kernel.** The core loop and the host adapters: the root import,
`./testing`, `./pbt`, `./do`, `./react`, `./node`, `./mem`, `./extension`,
`./parity`, `./devtools`, `./machine-viz`. Breaking changes here are deliberate
and rare. While the package is at 0.x a break lands in a **minor** with an
explicit callout in the changelog; from 1.0 it forces a **major**. This is the
promise you are buying if you build a product on the library.

**`battery` — a published named pattern built over the kernel.** Today
`./retry-backoff`. A battery **may break in a minor**, before and after 1.0,
provided the changelog for that minor says so. The point of the tier is that a
battery break never forces a major on someone who never imported it.

**`experimental` — no stability promise.** Today `./agent`. It may change or
disappear in **any** release. It carries the highest strategic weight and the
least mileage, which is exactly the combination that must not be dressed up as
stable. Moving to `battery` or `stable` is a deliberate re-stamp, not something
that happens by drift.

## How to read this as a consumer

- **Building something you have to keep running?** Stay on `stable`. Everything
  needed to run, persist and test a machine is there.
- **Reaching for `./agent`?** Do it — it is the headline surface — but pin an
  exact version and read the changelog before you bump. Treat an upgrade as a
  small migration rather than a routine patch.
- **An import that is not in the export map is not a public API.** The package
  has real internal code — flow, resilience, timing, persistence ops, the journal
  — that it depends on and does not invite you to import. It has no tier and no
  promise, and it can move or vanish with no changelog entry at all. If you can
  only reach something by a deep path into files, that is the library telling you
  it is not yours.

## Why not one flat promise

Flattening every subpath to a single promise costs three things.

**The kernel becomes a semver hostage.** A breaking change to the least-settled
corner would force a major — or a dishonest minor — on the whole package,
including on people who only ever imported the core.

**Attention gets diluted.** Reading a flat export map, you cannot tell the
load-bearing core from a frontier experiment. Everything reads as equally
blessed, which means nothing does.

**The boundary drifts.** With no tier line, demo and integration code creeps onto
the published surface and the question "what is actually the kernel here" loses
its answer.

## Showcases are not on the map

An integration proof — the Raft showcase is the standing example — is not a
published subpath. It lives outside the package and consumes it exactly the way
you do. That is on purpose: if a kernel change breaks the showcase, the showcase
build goes red, which is the honest signal a demo exists to give. A demo that
imports internals cannot give that signal, and a demo published as an API is a
maintenance promise nobody meant to make.

## Removal, while the package is at 0.x

There is no deprecation holding pattern. When something is replaced, the removal,
every internal rewrite and the changelog entry land in the same change, and the
changelog names where each thing went. A collapse of several doors into one
**moves the parts, never drops them** — the surviving door re-exports what the
old ones did. Only a genuinely dead twin gets deleted outright, with its
migration named.

So an upgrade may require a rename, and the changelog will tell you which one.
What it will not do is leave you guessing where something went.

## Further reading

- [ADR 0010 — Export-map tiers](../../.decisions/0010-export-map-tiers.md) and
  [ADR 0016 — Removal lands in a minor at 0.x](../../.decisions/0016-removal-lands-in-a-minor-at-0x.md)
  — the decision records behind the policy, written for maintainers.
- `MAINTAINING.md` in the repository — the canonical tier stamp per subpath, and
  the store factory each host adapter ships.
