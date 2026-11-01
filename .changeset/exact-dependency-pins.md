---
"@demlik/tea": patch
"@demlik/code-graph": patch
"@demlik/structure-sweep": patch
"@demlik/backlog-sweep": patch
---

**You now get exact versions of these dependencies instead of a range.** Each is pinned at the version this repo already tested against, so nothing changes in the code that runs.

- `@demlik/tea`: `@standard-schema/spec` 1.1.0
- `@demlik/code-graph`: `chalk` 5.6.2, `commander` 11.1.0, `jsonc-parser` 3.3.1, `smol-toml` 1.9.0
- `@demlik/structure-sweep`: `smol-toml` 1.9.0, `tinyglobby` 0.2.17, `yaml` 2.9.0
- `@demlik/backlog-sweep`: `zod` 4.5.4

If your project uses a different version of one of these, your install now holds a second copy instead of sharing one. `@demlik/tea`'s peer ranges have not changed.
