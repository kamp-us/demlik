---
"@demlik/structure-sweep": minor
---

`structure-sweep pairs --redact` keeps file paths out of what Jev sees, the `pairs` question reads
neutrally, and two `sweep` evidence fixes (#418, #417, #419, #421).

- **`pairs --redact`.** Jev sees each function's name and source only, so moving a file cannot move
  the answer on byte-identical bodies. `pairs.json` still records both real paths; a redacted row
  carries `"redacted": true`, and redaction is part of the pairs cache key, so a redacted run never
  reuses a plain answer or the other way round. A run without the flag sends the same state and
  writes the same rows as before.
- **Neutral pairs wording.** The `verdict` question no longer tells Jev that a static analyser
  flagged the pair or asks what "the resemblance" means; it states what `state.a`, `state.b` and
  `state.signals` are and asks how the two functions relate. This invalidates cached `pairs`
  answers: they were given under the old wording, and the cache key (the two bodies) does not see
  the prompt, so a re-run would still serve them. Delete `pairs.json` (or pass a fresh `--out`) to
  judge every pair under the new wording. The verdict keys are unchanged.
- **Bare imports no longer swallow the next line.** In `sweep` evidence, a bare `import "…"`
  followed by an `export … from "…"` was read as one import: the file's `imports` recorded the
  re-export's specifier instead of the bare import's, and the re-export line vanished from the
  source. Each is now its own statement: the bare import is listed in `imports` and the re-export
  stays in the source. This changes the payload for affected files, but not the verdict cache key,
  so their cached rows are reused until the file's content changes.
- **Redacted ids no longer depend on the host locale.** `sweep --redact` numbers files in code-unit
  order instead of `localeCompare`, so the same files get the same ids on every machine.
