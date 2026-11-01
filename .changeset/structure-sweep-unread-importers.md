---
"@demlik/structure-sweep": patch
---

`move apply` now refuses a move that would break an import in a `.vue`, `.svelte`, `.mdx` or `.astro` file. It does not parse or rewrite these files, so a quoted string in one that a row would leave naming the wrong file, by a relative path, a package name or an alias from tsconfig `paths` or `package.json` `imports`, with or without a bundler query or hash after the path (`./one.ts?raw`), stops the run before the rename commit, naming the row, importing file and specifier. So does a string a row's destination would take over from the file it names now. This holds for a row inside one package as well as one crossing a package line, for a manifest and a hand plan, and for a run resumed over an earlier rename commit. A package-name string into a package a row leaves that apply cannot follow to a file is refused too, since it may name a moved file. Any other string in these files changes nothing, and neither does a `.md` file.
