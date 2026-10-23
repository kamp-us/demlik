---
"@demlik/code-graph": minor
---

`code-graph <dir> --unreachable --ci` now gates dead exports against `unreachable-ledger.json` at the repo root, instead of quietly running the smell gate. Record today's findings once with `--unreachable --accept-dead --reason "<why>"`; from then on `--ci` fails only on a finding the ledger does not name, and drops entries whose finding is gone, so the ledger only shrinks. Entries are keyed by scope, kind and id, so one file covers many packages. Both kinds (`dead`, `only-called-from-tests`) are gated by default; `--dead-only` gates only `dead`. `--reason` now also rides `--accept-dead`. A plain `--ci` is unchanged.
