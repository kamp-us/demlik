---
"@demlik/code-graph": minor
---

Every use site of a declaration now says how the name is used there. A `UseSite` was `{ file, line }` and is `{ file, line, kinds, members }`, in `--graph --edges` and in `--find`.

`kinds` lists, sorted, each way the name is used on that line: `import`, `export`, `type` or `value`. `members` lists, sorted, the properties read straight off the name on that line, so `orderSchema.parse(input)` is a `value` use with `members: ["parse"]`, and a schema that is only ever imported and used as `typeof orderSchema` shows no `value` use at all. That answers "is this schema ever parsed, or only read as a type?" from one `--find`, without opening each file.

**Additive.** Both fields are always present, so nothing that reads `file` and `line` changes. A function's call sites in `--find` carry `kinds: ["value"]` and `members: []`, so both node sets print one shape. The rule for each kind is in SPEC §8 C6.
