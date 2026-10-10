---
"@demlik/code-graph": minor
---

New: diff a package's published API against a base commit. `code-graph <package> --api <map>
--api-base <rev>` and `diffPublishedApi(root, map, base)` from `@demlik/code-graph/api` list, per
export subpath, the names added, removed and changed since `<rev>`, with before/after declaration
text and the subpath's tier. A change to a private type shows as a change to the published name
that uses it. The base commit's tree is read from git's objects into a temp folder outside the
checkout, so the checkout's files, index, branch and stash are left as they were; the "after" side
is the working tree as it is. A rev that names no commit exits 2. Without `--api-base`, nothing
changes.
