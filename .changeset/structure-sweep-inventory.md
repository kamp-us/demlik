---
"@demlik/structure-sweep": minor
---

`structure-sweep inventory` joins outputs already on disk into one consolidation list (#469):
dead exports from `code-graph --unreachable`, tiny-file merges from `consolidate.json`,
same-decision groups and shared-helper families from `pairs.json`, exported-name twins from a
`code-graph --graph` JSON, and confirmed rule groups from the groups file. It writes
`.structure-sweep/inventory.json` and `.structure-sweep/inventory.md`, ordered by lever and then by
deletions, biggest first, with a content-derived id and `{ file, startLine, endLine }` spans on
every entry. A missing input is a skipped lever, `--exclude <glob>` keeps files out of the merges,
and it calls no model and runs no other command. The library exports exactly `buildInventory` and
`renderInventory`, plus the type-only `Inventory`, `InventoryEntry`, `InventoryInputs`,
`InventoryOptions`, `LeverStatus`, `Span`, `Lever`, `Source`, `UnreachableInput`, `GraphInput`,
`ConsolidateInput` and `PairInput` (#477).
