---
"@demlik/tea": minor
---

Split the package into three entry points: the core, the Promise engine and the Effect engine

**Breaking:** `run`, `driveToDone` and `DriveToDoneOptions` moved from `@demlik/tea`
to `@demlik/tea/promise`. The root no longer exports them. Change the import:

```ts
// before
import { defineMachine, run } from "@demlik/tea";
// after
import { defineMachine } from "@demlik/tea";
import { run } from "@demlik/tea/promise";
```

- `@demlik/tea` is the neutral core (`defineMachine`, `Cmd`, `replay`, the pure
  types). It imports no engine.
- `@demlik/tea/promise` (stable) is today's engine, unchanged apart from where
  it lives.
- `@demlik/tea/effect` (experimental) is published empty for now. The Effect
  engine lands there later. `effect` is a new **optional** peer dependency, so a
  Promise user installs nothing new.

An import-graph test keeps the three apart: the core reaches neither engine,
`./promise` and `./effect` never import each other, and only `./effect` may
import `effect`.
