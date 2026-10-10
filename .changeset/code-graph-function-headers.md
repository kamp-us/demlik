---
"@demlik/code-graph": minor
---

Add `--headers`: each function node in the JSON gets a `header` field with its declaration header as written, from where its `startLine` points to the last token before its body, with no leading comment. An overloaded function also lists its overload signatures, in source order, each with its start line. Without the flag the field is absent and the output does not change.
