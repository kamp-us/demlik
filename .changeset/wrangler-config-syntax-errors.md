---
"@demlik/code-graph": patch
---

A wrangler config with a syntax error anywhere is now unparsed. The loader used to repair a mistake
in the middle of a `.json` or `.jsonc` file into an object and count it as read, so a worker whose
service binding the mistake lost escaped `--boundaries`, which could return green over input it
could not see. It now reads a config as wrangler's own reader does, and a config with a syntax error
is listed as unparsed:

- `--boundaries` refuses on it (exit 2, one line naming the file, nothing written) when
  `binding-outside-driven-adapter` (B17), `worker-call-cycle` (B18) or a `readAllowance` is
  declared, as it already did for a config that fails outright.
- `--data` and `--cross-runtime` print it as `UNPARSED CONFIG` and read no binding from it.

Comments, trailing commas and a leading byte-order mark stay accepted, so a config wrangler deploys
is never refused. Output shapes, flags and exports are unchanged.
