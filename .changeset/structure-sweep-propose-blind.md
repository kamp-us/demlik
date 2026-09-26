---
"@demlik/structure-sweep": minor
---

`structure-sweep propose` reads the code, not only the names around it (#409, #415).

- Two content signals join `signals.json` and the prompt: terms split out of every swept file's
  exported names, and import clusters — files more tightly linked by relative imports to each
  other than to the rest, each given as its member files. Every list is capped, so the prompt does
  not grow with the file count.
- `--blind` leaves out folders, packages and code-graph clusters and names files by opaque ids
  (`f<n>`, in code-unit order of path), so a vocabulary can be drafted, and `propose` measured,
  without the folder names that encode the answer.
- A fifth built-in role, `flows` (`flows/`), for code that orchestrates a multi-step user or
  system flow: sagas, wizards, workflows and step sequencing.
