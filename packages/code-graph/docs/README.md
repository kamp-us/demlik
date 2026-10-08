# Code-graph documentation

[Package README](../README.md)

## How-to

- [Adopt a boundary gate](./how-to/enforce-boundaries.md): declare rules,
  record existing crossings, and block new ones in CI.

## Reference

- [CLI](./reference/cli.md): flags, scope, file selection, output, and exit codes.
- [Analyses](./reference/analyses.md): result meanings and detection limits.
- [Layers](./reference/layers.md): ordered layers and allowed violations.
- [Boundaries](./reference/boundaries.md): features, doors, libraries, workers,
  tests, and the crossing ledger.
- [Library API](./reference/library.md): the four named ESM subpaths.

## Explanation

- [How analysis works](./explanation/how-analysis-works.md): the syntax/checker
  split, uncertainty, repeatability, and verification.

The [extraction specification](../SPEC.md), [HTML design notes](../HTML-VIEW.md),
and [benchmark record](../bench/FINDINGS.md) provide implementation background.
