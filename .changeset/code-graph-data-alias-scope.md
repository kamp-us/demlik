---
"@demlik/code-graph": patch
---

`--data` scopes binding aliases lexically (#463).

An alias such as `const db = c.env.DB` used to leak into every sibling anonymous callback that
shared its enclosing named function — or, since #460, the whole module — so a second Hono handler's
own `db` parameter or `const db = c.env.OTHER` could resolve to the first handler's binding. Aliases
now follow JavaScript's own scoping: every function (arrow, function expression, method, function
declaration) opens a scope that inherits the one around it, and so does every block, `for` head,
`switch` and `catch` for its `let`/`const`/class declarations, while a `var` stays with its
function. A parameter or declaration of the same name shadows the outer alias only where it is in
scope, so sibling callbacks and sibling blocks each resolve their own `db`, and an outer alias still
reaches the code a nested block's redeclaration does not cover. Which function holds a site is
unchanged.
