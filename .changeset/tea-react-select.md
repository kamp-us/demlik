---
"@demlik/tea": minor
---

You can now write `useRuntime(run, (model) => model.views[id])` to read one part of the model and re-render on runtime updates only when that part changes. Pass `{ onError }` as the third argument when needed. Existing whole-model calls and the stable, returnless `send` keep working. Closes issue 853.
