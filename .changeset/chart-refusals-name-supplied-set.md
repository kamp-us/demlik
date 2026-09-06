---
"@demlik/tea": patch
---

The chart compiler's four compile-time refusals name the set that was supplied.

An edge naming a cell with no implementation, a per-site cell missing an entry for an edge, an edge
naming a guard with no implementation, and the reducer-chart safety net each used to end at the
missing name — so an author authoring a chart by hand could not tell a misspelling from an
omission. Each now lists what WAS there: the cells supplied, the edges the per-site bag carries,
the guards supplied, and the edges the reducer chart declares. The four render their clause through
one shared helper, so the phrasing cannot drift between them, and an empty supplied set reads as
words rather than an empty pair of brackets — the same reading `NoCellError` gives its empty
accepted set.

The reducer safety net additionally says what it is: a library net under a compile-time obligation
(`on` is total over the event alphabet), not an error in the author's chart, so a reader who
somehow reaches it knows they are looking at a library bug rather than a mistake of their own.

Each message's pre-existing text is kept verbatim as a prefix, so a caller matching on it keeps
matching.
