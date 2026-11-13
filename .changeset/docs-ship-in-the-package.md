---
"@demlik/tea": minor
---

The package now ships its `docs/` beside `dist`, so an installed copy holds the
tutorials, how-tos, reference, explanations and the glossary. A page's links to
the repo's decision records, patterns, examples and source are GitHub URLs,
since the tarball holds none of those files.

New how-to, "Find a wrong machine with a law": it finds an order machine that
charges the wrong amount with `arbSchemaGuidedSequence`, `foldEvents` and
`lawTrace` from `@demlik/tea/testing/effect`. `arbSchemaGuidedSequence` and
`lawTrace` stay `@experimental`; `foldEvents` keeps the stable promise of the
subpath. The glossary gains `law`, and an `Avoid:` line on `subpath` (door) and
`battery` (battery layer). No export, subpath or tier changes.
