---
"@demlik/code-graph": minor
---

A package is now a workspace member per `pnpm-workspace.yaml` or the root `package.json`'s `workspaces` (array or Yarn object form). Workspace patterns are matched as pnpm matches them. A fixture `package.json` outside those patterns no longer counts as a package, so it no longer triggers B11 or creates a package boundary for B19, including in scoped runs. An empty `pnpm-workspace.yaml` or one without `packages` holds only the root package, as pnpm reads it. Repos without a workspace manifest are unchanged.
