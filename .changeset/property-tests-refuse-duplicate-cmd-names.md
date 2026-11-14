---
"@demlik/tea": minor
---

The property-test entries now refuse a machine that lists two Cmds under one name, as `defineMachine`, `run` and `drive` already do. A machine written as a plain object, or a built one spread with a new `cmds`, can still carry such a list. `arbSchemaGuidedSequence` accepted it and answered every waiting Cmd of that name from the schema of the one listed last, so a law was judged on answers the machine could never receive and nothing said so. Now `arbSchemaGuidedSequence`, `arbGuidedSequence`, `propertyTerminates`, `propertyInvariant` and `propertyTrace` throw `CmdNameCollisionError`, naming the Cmd, before they draw or fold a list. It is a thrown breach, not a failed `Result` like `NoCmdsError`. Give each Cmd its own name, and list a def once.
