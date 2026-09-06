---
"@demlik/tea": minor
---

**BREAKING (experimental tier): the `chart` family is removed.** Nine subpaths are gone from the
export map:

- `@demlik/tea/chart`
- `@demlik/tea/chart/inspect`
- `@demlik/tea/chart/inspect/react`
- `@demlik/tea/chart/inspect/styles.css`
- `@demlik/tea/chart/report`
- `@demlik/tea/chart/lane`
- `@demlik/tea/chart/lane/react`
- `@demlik/tea/chart/lane/styles.css`
- `@demlik/tea/chart/lane/server`

All nine carried the `experimental` tier in `MAINTAINING.md`, which is why this is a `minor` and
not a `major`.

**There is no replacement and no migration path.** Chart authored a machine as config and drew a
fabrika lane; neither belongs in a state-machine substrate. The kernel (`defineMachine`, `run`,
`replay`) and `@demlik/tea/machine-viz` are unaffected — nothing outside `src/chart/` imported it.

**Last version that ships it: `0.13.0`.** The last commit carrying `src/chart/` is
`78bf0966` (`git show 78bf0966` restores any of it). Git history is the archive; the code was not
extracted to another package.

**Known affected consumer:** `kamp-us/phoenix` imports `@demlik/tea/chart/lane/server` and will
break on the next release. Pin `@demlik/tea@0.13.0` or vendor the module from the commit above.
Migrating phoenix is tracked separately.
