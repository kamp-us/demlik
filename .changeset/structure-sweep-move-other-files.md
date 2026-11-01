---
"@demlik/structure-sweep": patch
---

`move apply` moves rows that name a non-TypeScript file (a `.json` fixture, a `.sh` script, a
README) instead of throwing "Could not find source file in project". Such a row is renamed with
`git mv` in the same rename commit as the TypeScript rows, a module specifier naming it (`import
data from "./fixture.json" with { type: "json" }`) is rewritten to its new path, and a plain-string
relative reference to its old path (`new URL("./run.sh", import.meta.url)`) is listed in the
stale-string report and left as written.
