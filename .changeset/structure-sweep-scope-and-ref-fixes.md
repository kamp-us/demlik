---
"@demlik/structure-sweep": patch
---

Three correctness fixes in the lowering and `sweep --redact` (#451, #452, #453).

- **A `switch` discriminant names the outer variable.** The lowering's neutral naming resolved the
  value a `switch` switches on inside the case block's scope, so `switch (x) { case 1: let x = 2; }`
  named the case-local `x` in its path conditions. The discriminant now resolves in the enclosing
  scope, and a case body still resolves to the case's own declarations.
- **`sweep --redact` refuses an alias answer from the wrong tree.** Aliases resolve through the
  checkout on disk, while sources come from `--ref`. When the working tree differs from `--ref` in
  anything resolution reads (a path added, removed or retyped, or any JSON file such as a tsconfig
  or `package.json` edited), the run now stops before asking Jev and names every such path, instead
  of giving an alias an opaque id read off the working tree.
- **No raw line separators in source.** `isLineEnd` writes U+2028 and U+2029 as escapes, and a
  repo test fails on either raw character in any package's `src/`.
