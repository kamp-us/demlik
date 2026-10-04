---
"@demlik/tea": patch
---

Every public export now carries a description. 102 of them had none, including
`defineMachine`, `replay`, `Store`, `Machine`, `Sub`, the `Cmd` helpers and the
Promise engine's `run`, so their editor hovers and their rows in the generated
reference were blank.
