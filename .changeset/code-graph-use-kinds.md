---
"@demlik/code-graph": minor
---

Every use site of a declaration now says how the name is used there. A `UseSite` was `{ file, line }` and is `{ file, line, kinds, members }`, in `--graph --edges` and in `--find`.

`kinds` lists, sorted, each way the name is used on that line: `import`, `export`, `type` or `value`. `members` lists, sorted, the properties read straight off the name on that line, so `orderSchema.parse(input)` is a `value` use with `members: ["parse"]`, and a schema that is only ever imported and used as `typeof orderSchema` shows no `value` use at all. That answers "is this schema parsed here, or only read as a type?" from one `--find`, without opening each file. The lists describe the line, not where the value goes next: a name passed as an argument or bound to another name is a `value` use with no members.

**What changes for a reader of the output:** every use site gains two keys and loses none, so a reader that takes `file` and `line` is untouched. Two readers do have to change. One that parses the JSON with a strict schema of its own must allow `kinds` and `members`. One that builds a `UseSite` by hand, or parses older output with `UseSiteSchema`, must supply both: they are required, never optional. A function's call sites in `--find` carry `kinds: ["value"]` and `members: []`, so both node sets print one shape. The rule for each kind is in SPEC §8 C6.
