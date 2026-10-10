---
"@demlik/code-graph": patch
---

Bodiless constructors and bodiless class get/set accessors are no longer function nodes. A constructor's overload signatures, an `abstract` accessor and the members of a `declare class` used to each get a node; now only the constructor or accessor with a body does, as SPEC §6 A1 already said. Interface `get` / `set` signatures stay nodes. Function ids change in files that had such members: a phantom node is gone, and the `#n` ordinals of the real constructors and accessors beside it no longer count it. Code without them gets the same output as before.
