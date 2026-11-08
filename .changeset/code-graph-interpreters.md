---
"@demlik/code-graph": minor
---

`code-graph --boundaries` gains `interpreters`, a rules key that gives each technology one interpreter, and two kinds that hold it: B24 `technology-outside-interpreter` and B25 `interpreter-imports-feature`. Naming a scope in `interpreters` is the switch, so a rules file without it, or with `{}`, reports, gates and writes the same bytes as before.

```json
{ "interpreters": { "apps/cli": { "cli": { "root": "src/interpreters/cli", "modules": ["@b8e/kontrol-operations", "src/util/graphql"] } } } }
```

B24 reports a feature's `ports.ts` or adapter file (either layout) that imports a module a technology of its scope covers, once per file per technology: static, type-only, `export … from`, dynamic and type-position `import()` and `import x = require()` all count, and test files and a technology no scope lists are not judged. B25 reports a file under a root that imports any file of a feature, `index.ts` included, and replaces B4 for those edges. A file under a root is an adapter in the zone table: it may be impure, may use a worker binding (and be a `bindingOwners` owner), and satisfies `importedFrom: ["driven"]`.

A scope with no `features`, an empty `modules`, a package entry that is no glob, a root that is, holds or sits inside a feature or `lib` folder, two roots where one holds the other, a root with no source file the scope loads, or a `src/` module that names no file or folder the scope loads exits 2 and writes nothing.
