---
"@demlik/code-graph": minor
---

`--unreachable` reports `unused-export`: an exported function, type alias, interface, enum, class or constant, outside the public surface, that no other loaded file uses. Uses are checker-resolved, so a same-named identifier elsewhere never hides a finding, and a test file's import counts as a use. The findings sit in their own `unusedExports` list of the reachability report. Public is the set `public-entry-surface` already reads, with one fix: an `exports` target ending in `*` (such as `"./dist/*"`) now makes every file below it public, so in such a package a `dead` or `only-called-from-tests` export is withheld as `public-entry-surface` instead. Otherwise `unreachable`, `withheld` and the counts do not change.

`--unreachable --ci` gates `unused-export` by default, `--accept-dead` records it, and `--dead-only` leaves it out. **An existing `--unreachable --ci` run can go red on upgrade** until the new findings are accepted with `--unreachable --accept-dead --reason "<why>"` or their `export` keywords are dropped.
