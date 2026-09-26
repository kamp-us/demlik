---
"@demlik/structure-sweep": minor
---

`structure-sweep sweep --redact` shows Jev opaque ids instead of names (#407).

Under it, the file's path becomes an id that keeps only its extension, every relative import
specifier (in any import, re-export, dynamic `import()` or `require()` form, in the import list and
in the source) becomes an id, and importing siblings and `--graph` caller/callee files are listed
by id with their counts kept. Package specifiers are kept. `verdicts.json` still records the real
path; redacted rows carry `"redacted": true`, and the cache never serves a redacted answer to a
default run or the other way round. A default run's payload and verdict file are unchanged.
