---
"@demlik/tea": minor
---

`matchesIdentity` answers whether the engine would let a message through a machine's identity filter or drop it. Hosts that step a machine themselves call it before `applyCell` to enforce the same rule as `run`.
