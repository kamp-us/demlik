---
"@demlik/tea": minor
---

**Additive (declaration only):** `useRuntime` from `@demlik/tea/react` takes an optional selector, so a reader takes only its part of the model: `useRuntime(run, (model) => model.views[id])` re-renders on a run update only when that part changes. Pass `{ onError }` as the third argument when needed. No existing call needs editing: `useRuntime(run)` and `useRuntime(run, { onError })` return the whole state and the same returnless `send` as before. Closes issue 853.
