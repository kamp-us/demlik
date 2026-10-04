---
"@demlik/tea": minor
---

`@demlik/tea/effect` now exports `stop`, the helper a host stops one child
with. `stop(scope)` takes the scope `spawn` handed the child's `start` and
closes it: the child's run stops, `remove` takes its entry out of the host's
table and `notify` tells the parent. It does not wait for `notify`, so a parent
Cmd handler can call it, and stopping a child twice sends one notice. tea still
keeps no table: the lookup by id stays the host's.

The `spawn` docs no longer say the table never holds a child that is not
running. They say it never holds a child whose scope has closed, and that
`child.run.stop()` stops the run without removing the entry or telling the
parent. The `stop()` doc on the Effect handle says the same.

`docs/how-to/run-many-machines.md` and its two examples stop a child through
the helper. `examples/parent-and-workers-effect.ts` now exports `stopWorker`
where it exported `stop`.
