---
"@demlik/structure-sweep": patch
---

`move apply` now refuses a move that would break an import in a `.vue`, `.svelte`, `.mdx` or `.astro` file. It does not parse or rewrite these files, so a quoted string in one that a row would leave naming the wrong file, by a relative path, a package name or a tsconfig alias, stops the run before the rename commit, naming the row, importing file and specifier. This holds for a row inside one package as well as one crossing a package line, for a manifest and a hand plan, and for a run resumed over an earlier rename commit. A file of these kinds that names no moved file changes nothing, and neither does a `.md` file.
