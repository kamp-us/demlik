---
"@demlik/code-graph": minor
---

B17 `binding-outside-driven-adapter` now treats the file a worker's wrangler config names as `main`
as clean for that worker's own bindings, because that file is where the worker wires its bindings
to the driven adapters. It holds whether or not the file sits in a feature and whether or not
`bindingOwners` names the binding, so a repo no longer carries an accepted exception for each
worker's entry file. Every other file that reads a binding outside a driven adapter, a sibling of
`main` included, is still B17, and `bindingOwners` still refuses an owner that is not under an
`adapters/driven/`.

`testFiles` now matches a glob against a file's repo-relative path as well as its scope-relative
path. Every glob that matched before still matches, and a repo-relative glob such as
`services/*/test-support/**` allows test helpers in worker scopes alone. At scope `.` the two paths
are one string.
