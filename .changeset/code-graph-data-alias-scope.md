---
"@demlik/code-graph": patch
---

`--data` scopes binding aliases lexically (#463).

An alias such as `const db = c.env.DB` used to leak into every sibling anonymous callback that
shared its enclosing named function — or, since #460, the whole module — so a second Hono handler's
own `db` parameter or `const db = c.env.OTHER` could resolve to the first handler's binding. Every
function-like node (arrow, function expression, method, function declaration) now opens its own
alias scope that inherits the one around it, and a parameter or local declaration of the same name
shadows the outer alias. False-positive data edges and misattributed bindings from name reuse are
gone; which function holds a site is unchanged.
