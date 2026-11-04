---
"@demlik/code-graph": minor
---

`code-graph --boundaries` gains B21 `package-import-crosses-deployable`, enabled only when a rules file lists it in `acrossDeployables`. A package import of another workspace whose root holds a worker config is one crossing per importer and target workspace, including subpaths and type-only imports. Test files are judged too. Libraries, non-worker apps and a workspace importing its own package name are clean.

The rule uses the existing worker manifest catalog and reads workspace package names once per run. An unreadable worker config exits 2 and writes nothing while B21 is listed. Entries have B19's workspace target shape and work with `--ci`, `--accept-crossings` and `--migrate-ceilings`.
