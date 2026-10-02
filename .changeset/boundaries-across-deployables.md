---
"@demlik/code-graph": minor
---

`--boundaries` now judges across deployables, beside the feature level (B1-B10) and the library
level (B11-B14). A repo of several workers and shared packages turns on three new kinds by naming
them in a new `--boundary-rules` key, `acrossDeployables`, and each fails the merge gate by name as a
`boundary-ledger.json` entry, recorded with `--accept-crossings --reason` and pruned as it is fixed:

- **B17 `binding-outside-driven-adapter`**: a worker binding (a service binding, or a D1, Durable
  Object, KV, R2 or queue binding) its owning worker's deploy config declares, used in a file that is
  not under a hexagonal feature's `adapters/driven/`. One entry per file per binding. It reuses the
  syntax-only call-site finder `--data` runs (`env.X`, `this.env.X`, `c.env.X`, one level of aliasing,
  a destructure off `env`), so it runs on the cheap pass and starts no type checker. An optional
  second key, `bindingOwners`, narrows a binding to exact driven-adapter files, as `doors` does.
- **B18 `worker-call-cycle`**: two or more workers that bind each other in a loop, one entry per
  strongly connected component of the service-binding graph the wrangler configs declare. Its scope
  is `.`, and only a run at the repo root measures it.
- **B19 `relative-import-crosses-workspace`**: a relative import whose target sits in another
  workspace than the importer, judged by nearest `package.json`. One entry per importer and other
  workspace; a path alias and a bare specifier are not judged.

**The three kinds are off until listed**, so a minor release never fails the gate of a repo that did
not ask for them. A rules file that lists none is unchanged: its report, ledger entries and `--json`
are exactly what they were, no wrangler config is read, and no further repo listing is made. With a
kind listed, `--boundaries` ends its report with a census of the worker bindings it read (`deployables`
in `--json`). `--migrate-ceilings` seeds the three kinds without counting them against a ceiling. A
bad declaration (a kind outside the three, or a `bindingOwners` that cannot be honoured) exits 2 and
writes nothing.

The `@demlik/code-graph/boundaries` subpath accepts the three new kinds in a ledger, so its
published schema widens. An older release refuses a ledger that holds them, so upgrade the tool
before committing one.
