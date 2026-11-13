---
"@demlik/tea": minor
---

A machine that lists two Cmds under one name is now refused, and the error names the Cmd. Until now the one listed last silently replaced the other, so a handler that returned the right answer saw it settle as `malformed_result`, far from the cause. `defineMachine` (and `Machine.make` on `@demlik/tea/effect`, which calls it) throws the new `CmdNameCollisionError` when the machine is built. A machine written as a plain object meets the same refusal when `run` or `drive` starts it, on both engines. The same def listed twice is refused too. `CmdNameCollisionError` is exported from `@demlik/tea`, carries `_tag` and the repeated `cmdType`, and is a thrown breach like `PortNameCollisionError`; give each Cmd its own name, or list a def once.

`toolRouter` on `@demlik/tea/agent` now throws the same `CmdNameCollisionError` for two tools with one name, in place of its own plain `Error`.
