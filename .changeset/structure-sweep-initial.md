---
"@demlik/structure-sweep": minor
---

First release. `structure-sweep sweep` asks Jev which feature and which role every source file in a
folder belongs to, against a vocabulary the repository supplies in `structure-sweep.config.json`, and
caches each answer by content hash and vocabulary. `structure-sweep pairs` judges
`code-graph --collapse --json` pairs as `same_decision`, `look_alike` or `shared_helper`.
`structure-sweep move plan|apply` moves files into `<scope>/src/<feature>/<role dir>` with their
imports rewritten, pinning entry files — config `main`/`bin`/`exports` traced back from `dist/` to
their source, and Next.js app-router files by convention (#345).
