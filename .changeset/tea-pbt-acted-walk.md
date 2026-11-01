---
"@demlik/tea": patch
---

The `@demlik/tea/pbt` runners no longer hash both states of every changed step to fill `msgCounts`. A step's states are now compared by a walk that stops at the first difference and doesn't look inside an object both states share, so a property on a large state costs about what its fold costs, with `failOnNeverActed` on or off. On plain data the counts are what comparing `structuralHash` gives, and `structuralHash` itself is unchanged.

**`failOnNeverActed` refuses less.** A `Date`, `Map` or class instance now fails the run only when a step's comparison reaches it. One in an object `prev` and `next` share, or past a difference in the same step, stays unread, and the run gets a real answer instead of "can't tell what acted". A step with a refused value in a shared object now counts by what else changed, where it used to count as acted.
