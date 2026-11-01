---
"@demlik/structure-sweep": patch
---

`move apply` keeps the extension each rewritten import specifier was written with. A `./check.ts`
or `./check.js` specifier stays `.ts` or `.js` after the move, in import and export declarations,
dynamic `import()` and type-position `import("…")`, and a `./x/index.js` keeps naming the index
file. NodeNext repos typecheck after a move again. Specifiers written without an extension are
rewritten as before.
