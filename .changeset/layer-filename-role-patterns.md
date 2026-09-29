---
"@demlik/code-graph": minor
---

`--layer-rules` path patterns gain two forms, so a layer can be declared by a file's role in its
name rather than by its folder:

- `**` as a whole segment matches zero or more whole path segments: `apps/**/y` claims `apps/y` and
  `apps/p/q/y`.
- `*` inside a segment matches zero or more characters and never crosses `/`: `**/*-plumbing.ts`
  claims every `*-plumbing.ts` file at any depth.

A whole-segment `*` keeps its one-or-more meaning, and `?`, `[...]`, `{}` and `!` stay literal.

Specificity now compares depth (segments other than `**`), then literal segments (segments with no
`*`), then literal characters (characters other than `*` and `/`). The first two keys are the old
order, so a pattern using neither new form ranks as before; where two patterns tied on both, the
old order picked one alphabetically.

That alphabetical pick is gone. When a file's most specific patterns tie on all three keys and
belong to different layers, `--layers` refuses: exit code 2, one line naming the file and both
patterns, and no census or violations. A tie inside one layer is not refused.
