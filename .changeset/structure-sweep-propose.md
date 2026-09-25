---
"@demlik/structure-sweep": minor
---

`structure-sweep propose <folder>...` gathers the signals for drafting a feature vocabulary
(#385).

It writes `.structure-sweep/signals.json` (folders under each folder, workspace package names,
and code-graph clusters and cross-runtime calls when `--graph` is given) and
`.structure-sweep/propose-prompt.md`, a prompt that asks you or your coding agent to draft the
vocabulary, write it as a config, and check it with `sweep` and `score`. It calls no model and no
network, reads no API key, and refuses to overwrite either file without `--force`.
