---
"@demlik/tea": patch
---

A boot failure after the provider graph opened now releases it. `run` acquires a
`provide({ … })` graph as boot's first step; if a later boot step threw —
`store.load()`, `store.migrate()`, the boot save, or the initial interpret —
`ready` rejected with every provider still acquired, and only a `stop()` the
host had no reason to call would close them. The remaining boot steps now run
inside the graph's lifetime, so a throw releases every acquired provider in
reverse before the rejection surfaces, symmetric with the unwind `open()`
already does for a failed `acquire`.

`Scope.release` is idempotent, so the `stop()` a careful host still calls after
such a rejection stays a no-op and never double-releases.
