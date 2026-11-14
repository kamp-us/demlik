---
"@demlik/code-graph": patch
---

`code-graph <featureDir> --hexagon` and `--owners` now mark a feature's two main lists as not read when its `ports.ts` does not parse or cannot be read.

Before, a `ports.ts` with a syntax error printed `none` under both Commands and External systems and held `[]` for `commands` and `externalSystems` in `--json`, so the report read as "this feature has no commands" while the file had not been read at all; only the Not read section named it. Now both lists hold the `<source>` row, `not read: ports.ts:1 <source>: cannot parse source` in text and `{ "notRead": { "file": "ports.ts", "line": 1, "name": "<source>", "reason": "cannot parse source" } }` in `--json` and per feature in `--owners`, whether or not a `create…` function names the feature. The reason is `cannot read source` when the file cannot be read. A `ports.ts` that parses prints as before, and the exit code stays 0.
