---
"@demlik/code-graph": minor
---

`code-graph --boundaries` reads a service laid out in Cockburn's top-level port shape, not only the
per-feature one. A scope whose `features` list `application`, `driving-adapters` and
`driven-adapters` is one hexagon with those three folders straight under `src/`: a binding used in
`driven-adapters/` is no longer a false B17, and B6 (an application importing an adapter) and B8 (a
driving adapter reaching an application use case or a driven adapter) now run on that shape, where
they were silent.

  - `application/driving-ports/` and `application/driven-ports/` are the ports zone, the rest of
    `application/` is the application, `driving-adapters/` and `driven-adapters/` are the driving
    and driven zones. B7 judges them like the per-feature zones, and a file outside the three
    folders, such as a worker entry, may import any of them, so B4 does not flag the wiring.
  - A folder named for a port-layout zone makes the scope a port-layout scope. A scope that lists
    one of them and a feature folder exits 2 with a message naming the scope and the two kinds, and
    writes nothing.
  - `bindingOwners` and `readAllowance` accept a file under `src/driven-adapters/`; their refusals
    now name both the per-feature path and the port-layout path.
  - The rules file gains no key. The zone paths of both layouts are one table in `rules.ts`, and B6
    reads whether the target is an adapter from that table. The per-feature layout's verdicts and
    ledger entries are unchanged.
