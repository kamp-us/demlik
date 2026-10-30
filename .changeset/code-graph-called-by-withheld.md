---
"@demlik/code-graph": minor
---

`--unreachable` no longer reports a function as dead when its only caller is withheld. A function called only by a withheld function is now withheld as `called-by-withheld`, not reported as `dead` or `only-called-from-tests`. The walk starts from functions withheld as `public-entry-surface` or `referenced-in-non-test-file`, follows calls and references, and wins over `referenced-in-non-test-file`. Test-support functions start no walk, and `reachableCount` is unchanged. `called-by-withheld` is a new value of the `withheld[].reason` field in the JSON output.
