---
"@demlik/tea": minor
---

Add `Machine.make` to `@demlik/tea/effect`. Required `model` and `msg` Effect schemas supply the model and plain message types. Required `cmds` supplies commands and their settled messages; use `[]` for no commands. Optional `types` holds only `sub` and `ctx`.

The maker returns tea's existing machine and uses schemas for types only. Core `defineMachine`, initialization and engine behavior stay unchanged.
