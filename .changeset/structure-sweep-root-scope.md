---
"@demlik/structure-sweep": minor
---

`pairs` and `sweep` accept the repository root as a folder (#467).

- **`pairs .=<collapse.json>` judges the whole-tree report.** A pair whose two
  functions sit in different top-level folders only appears in
  `code-graph . --collapse --json`, and `pairs` used to refuse `.`, so those
  pairs were never judged. The root, or any folder argument that resolves to it
  (`..` from `packages/`), is now the scope `.`: its rows carry `"scope": "."`
  and each side's repo-relative path, a second `.` run replaces only the `.`
  rows, and answers a per-folder run already gave are reused.
- **`sweep .` judges every tracked source in the tree** and records
  `"scope": "."` on its rows.
- A folder outside the repository is still refused, and `move` and `propose`
  still refuse the root.
