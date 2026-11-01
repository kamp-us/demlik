---
"@demlik/code-graph": minor
---

Add an API ledger, so a repo with no changesets can fail lint on a new public name. `--api <map> --accept-api --reason "<why>"` records today's published names in `api-ledger.json` at the repo root. `--api <map> --ci` then exits 1 on a published name the ledger does not hold, listing each by subpath and name, and prunes entries whose name is gone. An entry is keyed by scope, subpath and name, so a signature change on a recorded name is not a failure. The path runs no git command and needs no base commit, and `--json` prints `{ passed, scope, unrecorded, pruned }`. An unreadable or schema-invalid ledger exits 2 before any emit. `--api-base` and `--api-policy` runs keep their output and exit codes.
