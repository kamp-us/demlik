---
"@demlik/code-graph": minor
---

`code-graph <pkg> --api <map> --api-docs <shape>` lists every published declaration whose doc block is missing or out of the shape you hold the package to.

Before, nothing checked that a public export was documented. A lint rule sees the `export` keyword and cannot tell a published name from a private one, so a new public class could land with no doc block and every check stayed green. `--api <map>` already says which names a package publishes; `--api-docs` reads the source behind those names.

`<shape>` is a JSON file you write: `skip` globs, the `order` tags stand in, and an `export` rule (`block` and `description`, each `"required"` or `"optional"`, with `required` and `forbidden` tags). code-graph ships no tag, order or rule of its own.

```
src/ledger/Log.ts:42  make  no doc block
src/ledger/Log.ts:57  open  missing @category
api docs: 37 exports judged, 2 with a finding
```

Each finding names the source file and line, the declared name and what is wrong: no doc block, an empty description, a missing tag, a forbidden tag, or a tag out of order. The members behind `export * as Name` and inside an `export namespace Name` are judged too, so a map that lists only a barrel does not pass with every member undocumented. The run exits 0 whatever it finds; when the read could not see everything (a re-export it could not resolve, a syntax error, a name with no declaration) it prints one warning line per gap on stderr.

`@demlik/code-graph/api` exports the reader and the judgment: `readApiDocFacts`, `judgeApiDocs` and `ApiDocsShapeSchema`.

One refusal of `--api <map>` changed on the way: a map entry in a folder whose name only starts with two dots, such as `..hidden/index.ts`, is inside the package and is no longer refused as lying outside it.
