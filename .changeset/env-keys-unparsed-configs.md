---
"@demlik/code-graph": patch
---

`--env-keys` now lists every wrangler config it could not parse, as `UNPARSED CONFIG` lines under
its header and as a sorted `unparsedConfigs` array in `--json` (`[]` when every config parses),
as `--data` and `--cross-runtime` already do. A read is judged by the nearest wrangler config above
its file, parsed or not; when that config is an unparsed one the read is withheld as the new reason
`read-site-owner-unparsed`, where it used to be reported as `read, never declared` against the worker
above it or counted as `read-site-owner-unknown`. A config that cannot be parsed declares no key.

The exit code and flags are unchanged, and a workspace whose configs all parse prints what it
printed before, with `--json` gaining the one key.
