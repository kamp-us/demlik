---
"@demlik/structure-sweep": minor
---

`move plan` now needs the import graph and Jev to agree before it moves a file, and `move apply`
commits the renames apart from the import rewrites (#411, #413).

`move plan` reads the scope's import graph (every resolved relative import between tracked sources,
through the scope's `tsconfig.json`). A file's graph pull is the named feature holding a strict
majority of its import edges, both directions, to files Jev put in a named feature. A file moves
only when that pull and Jev's feature agree and Jev's confidence clears the floor. When one side
says move, or they name different features, the file is a `review` row. Each `review` row now
carries both opinions, Jev's `feature`, `role` and `confidence` plus `graph: { feature, share, edges }`,
with `feature: null` and no `share` when there is no pull. A file neither side would move is no
longer listed, and a confident verdict with no pull no longer moves. `PlanInput` takes the
graph as `edges`.

`move apply` refuses to start over staged or unstaged changes to tracked files, or while an
untracked `.ts`/`.tsx` source sits under the scope, naming each path. It then makes two
commits: the first holds only the renames with content unchanged, so git records each as a 100%
rename and `git log --follow` keeps the history; the second holds the specifier rewrites, heals and
formatting, and is skipped when nothing changed. Both are a function of `HEAD` and the manifest. A
run that stopped after the rename commit resumes with the rewrite commit alone. The JSON report
gains `commits: { rename, rewrite }`, and apply no longer leaves anything staged.
