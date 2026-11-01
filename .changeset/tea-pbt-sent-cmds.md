---
"@demlik/tea": minor
---

A property run (`@demlik/tea/pbt`) looks at the Cmds a machine sends, so a reducer or `init` sending junk can't stay green.

- **A value with no string `type` fails the run.** It fails on every machine and every runner, with a `PropertyFailure` naming the value, whether `init` or a step sent it. This is the one change to a call using no new option: such a value was never a Cmd, and it used to pass unseen.
- **`failOnUndeclaredCmd`, a new option on `propertyTerminates`, `propertyInvariant` and `propertyTrace`.** It fails a run when `init` or a step sends a Cmd whose `type` isn't in `machine.cmds`, naming that Cmd. Off by default, because a machine can keep a hand-written Cmd beside its defined ones. It adds nothing on a machine that declares no `cmds`.
- **`initCmds`, a new field on what `foldEvents` returns, and a new last argument on each runner's check.** They hold the Cmds `init` sent, on a fresh start and on a loaded state. No `Step` holds them. `propertyInvariant`'s check runs once per step, so an empty list never shows them to it.

**Breaking (declaration only):** the published signatures of `stable` names changed, so the API ratchet asks for this callout. The checks take one more argument and `foldEvents` returns one more field. No existing check needs editing, and no existing seed draws anything new.
