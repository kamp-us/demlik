---
"@demlik/tea": patch
---

The optional `vitest` peer now accepts `^4` and `^5` beside `^2` and `^3`
(#293). npm 11 enforces optional peer ranges, so a project on vitest 4 or 5
got `ERESOLVE` when installing `@demlik/tea` next to it. tea's own suite,
including `@demlik/tea/testing`, now runs under vitest 5.
