---
"@demlik/tea": minor
---

**Breaking:** `Machine.make` on `@demlik/tea/effect` refuses two `msg` declarations it used to accept, so a machine that compiled before can be refused. Each refusal is a compile error on the `msg` line. A plain Msg whose tag is a settled Msg name of a listed Cmd, such as `fetch_file_ok` beside the Cmd `fetch_file`, put two different Msgs in one update cell; the error names each such tag, and the fix is to rename the Msg. A Msg whose tag is not a literal (`Schema.String`, or a `Schema.TemplateLiteral`) made the update table accept any cell name, so a misspelled cell compiled and failed only when a Msg reached it; the error says every tag must be a literal, and the fix is to give the Msg a `Schema.Literal` tag. A Msg named like its Cmd without the suffix (`fetch_file` beside `fetch_file`) is still accepted. `make` keeps its one signature.
